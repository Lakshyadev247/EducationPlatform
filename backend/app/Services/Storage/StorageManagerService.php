<?php

namespace App\Services\Storage;

use App\Models\StorageDocument;
use App\Models\StorageLog;
use App\Models\StorageProvider;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use InvalidArgumentException;
use RuntimeException;

class StorageManagerService
{
    public function __construct(
        private readonly StorageDiskFactory $diskFactory,
        private readonly AuditLogger $auditLogger
    ) {}

    /**
     * Get the currently active storage provider.
     */
    public function getActiveProvider(): StorageProvider
    {
        $active = StorageProvider::query()->where('is_active', true)->first();

        if (!$active) {
            $active = StorageProvider::query()->where('provider_key', 'local')->first();
            if ($active) {
                $active->update(['is_active' => true]);
            } else {
                $active = StorageProvider::query()->create([
                    'provider_key' => 'local',
                    'name' => 'Local Server Storage',
                    'driver_type' => 'local',
                    'is_active' => true,
                    'is_configured' => true,
                    'status' => 'connected',
                    'settings' => ['root' => 'documents'],
                    'last_tested_at' => now(),
                ]);
            }
        }

        return $active;
    }

    /**
     * Switch the active primary storage provider.
     */
    public function setActiveProvider(string $providerKey, ?User $actor): StorageProvider
    {
        $target = StorageProvider::query()->where('provider_key', $providerKey)->firstOrFail();

        if ($target->provider_key !== 'local' && !$target->is_configured) {
            throw new InvalidArgumentException("Cannot activate provider '{$target->name}' before configuring its credentials.");
        }

        $previous = StorageProvider::query()->where('is_active', true)->first();
        $previousKey = $previous?->provider_key;

        if ($previousKey === $providerKey && $target->is_active) {
            return $target;
        }

        StorageProvider::query()->where('id', '!=', $target->id)->update(['is_active' => false]);
        $target->is_active = true;
        $target->save();

        // Audit & log
        $this->auditLogger->record(
            $actor,
            'switch_active_storage_provider',
            'StorageProvider',
            $target->id,
            ['active_provider' => $previousKey],
            ['active_provider' => $providerKey],
            "Switched active storage provider from {$previousKey} to {$providerKey}"
        );

        StorageLog::query()->create([
            'provider_key' => $providerKey,
            'action' => 'switch_active',
            'status' => 'success',
            'message' => "Active storage provider changed to {$target->name} (previous: {$previousKey})",
            'user_id' => $actor?->id,
            'ip_address' => request()?->ip(),
        ]);

        return $target;
    }

    /**
     * Test connection to a storage provider.
     *
     * @return array{success: bool, message: string, latency_ms?: int}
     */
    public function testConnection(string $providerKey): array
    {
        $provider = StorageProvider::query()->where('provider_key', $providerKey)->firstOrFail();

        if ($provider->provider_key !== 'local' && !$provider->is_configured) {
            return [
                'success' => false,
                'message' => "Provider '{$provider->name}' is not configured yet. Please provide required credentials first.",
            ];
        }

        $startTime = microtime(true);
        $probeFileName = '.ping-probe-' . Str::random(16) . '.txt';
        $probeContent = 'Storage probe ' . now()->toISOString() . ' [' . Str::random(32) . ']';

        try {
            $disk = $this->diskFactory->make($provider);

            // 1. Write probe
            $disk->put($probeFileName, $probeContent);

            // 2. Read probe & verify
            $readBack = $disk->get($probeFileName);
            if (trim((string) $readBack) !== trim($probeContent)) {
                throw new RuntimeException("Data integrity check failed: read content did not match written content.");
            }

            // 3. Delete probe
            $disk->delete($probeFileName);

            $durationMs = (int) round((microtime(true) - $startTime) * 1000);

            $provider->update([
                'status' => 'connected',
                'last_tested_at' => now(),
                'last_error' => null,
            ]);

            StorageLog::query()->create([
                'provider_key' => $providerKey,
                'action' => 'test_connection',
                'status' => 'success',
                'duration_ms' => $durationMs,
                'message' => "Connection test passed in {$durationMs}ms",
                'user_id' => auth()->id(),
                'ip_address' => request()?->ip(),
            ]);

            return [
                'success' => true,
                'message' => "Connection test passed successfully ({$durationMs}ms latency).",
                'latency_ms' => $durationMs,
            ];
        } catch (\Throwable $e) {
            $durationMs = (int) round((microtime(true) - $startTime) * 1000);
            $cleanError = $this->cleanErrorMessage($e);

            // Try to clean up probe if it was created
            try {
                if (isset($disk)) {
                    $disk->delete($probeFileName);
                }
            } catch (\Throwable) {}

            $provider->update([
                'status' => 'error',
                'last_tested_at' => now(),
                'last_error' => $cleanError,
            ]);

            StorageLog::query()->create([
                'provider_key' => $providerKey,
                'action' => 'test_connection',
                'status' => 'failure',
                'duration_ms' => $durationMs,
                'message' => "Connection test failed: {$cleanError}",
                'user_id' => auth()->id(),
                'ip_address' => request()?->ip(),
            ]);

            return [
                'success' => false,
                'message' => $cleanError,
                'latency_ms' => $durationMs,
            ];
        }
    }

    /**
     * Save provider configuration and credentials.
     *
     * @param array<string, mixed> $data
     */
    public function saveProviderConfig(string $providerKey, array $data, ?User $actor): StorageProvider
    {
        $provider = StorageProvider::query()->where('provider_key', $providerKey)->firstOrFail();
        $schema = StorageProviderRegistry::get($providerKey);

        if (!$schema) {
            throw new InvalidArgumentException("Unknown storage provider '{$providerKey}'.");
        }

        $credentials = $provider->getDecryptedCredentials();
        $settings = $provider->settings ?? [];

        foreach ($schema['fields'] as $field) {
            $name = $field['name'];
            $isSecret = !empty($field['secret']);

            if (array_key_exists($name, $data)) {
                $val = $data[$name];

                // If it's a secret and user sent masked placeholder '••••••••' or empty string when already configured, keep existing
                if ($isSecret) {
                    if ($val === '••••••••' || ($val === '' && !empty($credentials[$name]))) {
                        continue;
                    }
                    if ($val !== null && $val !== '') {
                        $credentials[$name] = (string) $val;
                    }
                } else {
                    if (in_array($name, ['bucket', 'region', 'endpoint', 'root', 'container', 'account_id', 'use_path_style_endpoint'], true)) {
                        $settings[$name] = $val;
                    } else {
                        $credentials[$name] = $val;
                    }
                }
            }
        }

        // Validate required fields
        foreach ($schema['fields'] as $field) {
            $name = $field['name'];
            if (!empty($field['required'])) {
                $hasInCreds = !empty($credentials[$name]);
                $hasInSettings = !empty($settings[$name]);
                if (!$hasInCreds && !$hasInSettings) {
                    throw new InvalidArgumentException("The '{$field['label']}' field is required for {$provider->name}.");
                }
            }
        }

        $provider->settings = $settings;
        $provider->credentials = $credentials;
        $provider->is_configured = true;
        $provider->status = 'untested';
        $provider->last_error = null;
        $provider->save();

        $this->auditLogger->record(
            $actor,
            'configure_storage_provider',
            'StorageProvider',
            $provider->id,
            [],
            ['provider_key' => $providerKey, 'configured' => true],
            "Updated configuration for {$provider->name}"
        );

        StorageLog::query()->create([
            'provider_key' => $providerKey,
            'action' => 'configure',
            'status' => 'success',
            'message' => "Provider {$provider->name} configuration saved",
            'user_id' => $actor?->id,
            'ip_address' => request()?->ip(),
        ]);

        return $provider;
    }

    /**
     * Disconnect and clear credentials for a provider.
     */
    public function disconnectProvider(string $providerKey, ?User $actor): StorageProvider
    {
        $provider = StorageProvider::query()->where('provider_key', $providerKey)->firstOrFail();

        if ($provider->provider_key === 'local') {
            throw new InvalidArgumentException("The local server storage cannot be disconnected.");
        }

        // If active, fallback to local first
        if ($provider->is_active) {
            $this->setActiveProvider('local', $actor);
        }

        $provider->credentials = null;
        $provider->is_configured = false;
        $provider->status = 'not_configured';
        $provider->last_tested_at = null;
        $provider->last_error = null;
        $provider->save();

        $this->auditLogger->record(
            $actor,
            'disconnect_storage_provider',
            'StorageProvider',
            $provider->id,
            ['provider_key' => $providerKey],
            ['configured' => false],
            "Disconnected storage provider {$provider->name}"
        );

        StorageLog::query()->create([
            'provider_key' => $providerKey,
            'action' => 'disconnect',
            'status' => 'success',
            'message' => "Provider {$provider->name} disconnected and credentials cleared",
            'user_id' => $actor?->id,
            'ip_address' => request()?->ip(),
        ]);

        return $provider;
    }

    /**
     * Upload a private, sensitive document (Aadhaar, PAN, certificates, etc.) to the currently active provider.
     *
     * @param array<string, mixed> $metadata
     */
    public function upload(
        UploadedFile $file,
        string $collection = 'general',
        ?User $owner = null,
        array $metadata = [],
        ?User $actor = null
    ): StorageDocument {
        $activeProvider = $this->getActiveProvider();
        $startTime = microtime(true);

        // Allowed document mime types
        $allowedMimes = [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/jpg',
        ];

        $mime = $file->getMimeType() ?: 'application/octet-stream';
        if (!in_array($mime, $allowedMimes, true)) {
            throw new InvalidArgumentException("Unsupported file type: {$mime}. Allowed types: PDF, PNG, JPG, JPEG, WEBP.");
        }

        // Max 15MB
        $size = $file->getSize();
        if ($size > 15 * 1024 * 1024) {
            throw new InvalidArgumentException("File size exceeds 15MB limit.");
        }

        $uuid = (string) Str::uuid();
        $ext = $file->getClientOriginalExtension() ?: 'bin';
        $originalName = $file->getClientOriginalName() ?: "document_{$uuid}.{$ext}";
        $checksum = hash_file('sha256', $file->getRealPath());

        $year = date('Y');
        $month = date('m');
        $safeCollection = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $collection);
        $filePath = "{$safeCollection}/{$year}/{$month}/{$uuid}.{$ext}";

        $disk = $this->diskFactory->make($activeProvider);

        // Upload stream/contents
        $contents = file_get_contents($file->getRealPath());
        $disk->put($filePath, $contents);

        $document = StorageDocument::query()->create([
            'uuid' => $uuid,
            'user_id' => $owner?->id,
            'provider_key' => $activeProvider->provider_key,
            'collection' => $collection,
            'original_name' => $originalName,
            'file_path' => $filePath,
            'mime_type' => $mime,
            'file_size' => $size,
            'checksum' => $checksum,
            'metadata' => $metadata,
            'created_by' => $actor?->id ?? auth()->id(),
        ]);

        $durationMs = (int) round((microtime(true) - $startTime) * 1000);

        StorageLog::query()->create([
            'provider_key' => $activeProvider->provider_key,
            'action' => 'upload',
            'status' => 'success',
            'document_id' => $document->id,
            'file_name' => $originalName,
            'file_size' => $size,
            'duration_ms' => $durationMs,
            'message' => "Document {$originalName} uploaded to {$activeProvider->name}",
            'user_id' => $actor?->id ?? auth()->id(),
            'ip_address' => request()?->ip(),
        ]);

        $this->auditLogger->record(
            $actor ?? auth()->user(),
            'upload_document',
            'StorageDocument',
            $document->id,
            [],
            [
                'document_id' => $document->id,
                'provider' => $activeProvider->provider_key,
                'collection' => $collection,
                'original_name' => $originalName,
                'size' => $size,
            ],
            "Uploaded document {$originalName} ({$collection})"
        );

        return $document;
    }

    /**
     * Read a document's raw content stream using the document's own provider.
     *
     * @return array{content: string, mime: string, size: int, filename: string}
     */
    public function getDocumentContent(StorageDocument $document, ?User $actor = null): array
    {
        $provider = StorageProvider::query()->where('provider_key', $document->provider_key)->first();
        if (!$provider) {
            throw new RuntimeException("Storage provider '{$document->provider_key}' for this document is not registered.");
        }

        $disk = $this->diskFactory->make($provider);
        if (!$disk->exists($document->file_path)) {
            throw new RuntimeException("File '{$document->file_path}' not found on provider {$provider->name}.");
        }

        $content = $disk->get($document->file_path);

        StorageLog::query()->create([
            'provider_key' => $document->provider_key,
            'action' => 'download',
            'status' => 'success',
            'document_id' => $document->id,
            'file_name' => $document->original_name,
            'file_size' => $document->file_size,
            'message' => "Document {$document->original_name} downloaded from {$provider->name}",
            'user_id' => $actor?->id ?? auth()->id(),
            'ip_address' => request()?->ip(),
        ]);

        return [
            'content' => $content,
            'mime' => $document->mime_type,
            'size' => $document->file_size,
            'filename' => $document->original_name,
        ];
    }

    /**
     * Generate a short-lived temporary download URL.
     */
    public function getTemporaryUrl(StorageDocument $document, int $expirationMinutes = 15): string
    {
        return URL::temporarySignedRoute(
            'api.storage.documents.download.signed',
            now()->addMinutes($expirationMinutes),
            ['document' => $document->id]
        );
    }

    /**
     * Delete a document from its provider storage and remove database record.
     */
    public function deleteDocument(StorageDocument $document, ?User $actor = null): bool
    {
        $provider = StorageProvider::query()->where('provider_key', $document->provider_key)->first();
        if ($provider) {
            try {
                $disk = $this->diskFactory->make($provider);
                if ($disk->exists($document->file_path)) {
                    $disk->delete($document->file_path);
                }
            } catch (\Throwable $e) {
                // Log and continue deletion of record
            }
        }

        StorageLog::query()->create([
            'provider_key' => $document->provider_key,
            'action' => 'delete',
            'status' => 'success',
            'document_id' => $document->id,
            'file_name' => $document->original_name,
            'file_size' => $document->file_size,
            'message' => "Document {$document->original_name} deleted",
            'user_id' => $actor?->id ?? auth()->id(),
            'ip_address' => request()?->ip(),
        ]);

        $this->auditLogger->record(
            $actor ?? auth()->user(),
            'delete_document',
            'StorageDocument',
            $document->id,
            ['file_name' => $document->original_name, 'provider' => $document->provider_key],
            [],
            "Deleted document {$document->original_name}"
        );

        return (bool) $document->delete();
    }

    /**
     * Compile management dashboard metrics.
     *
     * @return array<string, mixed>
     */
    public function getDashboardStats(): array
    {
        $active = $this->getActiveProvider();
        $totalDocuments = StorageDocument::query()->count();
        $totalBytes = (int) StorageDocument::query()->sum('file_size');

        $byProvider = StorageDocument::query()
            ->selectRaw('provider_key, count(*) as doc_count, sum(file_size) as total_bytes')
            ->groupBy('provider_key')
            ->get()
            ->keyBy('provider_key')
            ->toArray();

        $byCollection = StorageDocument::query()
            ->selectRaw('collection, count(*) as doc_count, sum(file_size) as total_bytes')
            ->groupBy('collection')
            ->get()
            ->keyBy('collection')
            ->toArray();

        // Upload stats (last 30 days)
        $uploadSuccess = StorageLog::query()
            ->where('action', 'upload')
            ->where('status', 'success')
            ->count();
        $uploadFailure = StorageLog::query()
            ->where('action', 'upload')
            ->where('status', 'failure')
            ->count();

        $recentLogs = StorageLog::query()
            ->with('user:id,name,email')
            ->latest('id')
            ->limit(10)
            ->get();

        return [
            'active_provider' => [
                'key' => $active->provider_key,
                'name' => $active->name,
                'status' => $active->status,
                'last_tested_at' => $active->last_tested_at?->toISOString(),
                'last_error' => $active->last_error,
            ],
            'total_documents' => $totalDocuments,
            'total_bytes' => $totalBytes,
            'formatted_total_bytes' => $this->formatBytes($totalBytes),
            'by_provider' => $byProvider,
            'by_collection' => $byCollection,
            'upload_stats' => [
                'success' => $uploadSuccess,
                'failure' => $uploadFailure,
                'success_rate' => ($uploadSuccess + $uploadFailure > 0)
                    ? round(($uploadSuccess / ($uploadSuccess + $uploadFailure)) * 100, 1)
                    : 100.0,
            ],
            'recent_logs' => $recentLogs,
        ];
    }

    private function cleanErrorMessage(\Throwable $e): string
    {
        $msg = $e->getMessage();
        // Remove raw query parameters or credentials from error messages
        $msg = preg_replace('/(Signature|Key|Token|Secret|password)=[^&\s]+/i', '$1=[redacted]', $msg);
        return Str::limit($msg, 300, '...');
    }

    private function formatBytes(int $bytes): string
    {
        if ($bytes < 1024) return $bytes . ' B';
        if ($bytes < 1048576) return round($bytes / 1024, 1) . ' KB';
        if ($bytes < 1073741824) return round($bytes / 1048576, 2) . ' MB';
        return round($bytes / 1073741824, 2) . ' GB';
    }
}
