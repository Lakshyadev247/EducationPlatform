<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\StorageDocument;
use App\Models\StorageLog;
use App\Models\StorageProvider;
use App\Services\Storage\StorageManagerService;
use App\Services\Storage\StorageProviderRegistry;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

class StorageController extends Controller
{
    public function __construct(
        private readonly StorageManagerService $storageManager
    ) {}

    public function dashboard(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        return response()->json([
            'data' => $this->storageManager->getDashboardStats(),
        ]);
    }

    public function providers(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $providers = StorageProvider::query()->get();
        $registry = StorageProviderRegistry::all();

        $result = $providers->map(function (StorageProvider $p) use ($registry) {
            $meta = $registry[$p->provider_key] ?? [];
            return [
                'id' => $p->id,
                'provider_key' => $p->provider_key,
                'name' => $p->name,
                'driver_type' => $p->driver_type,
                'category' => $meta['category'] ?? 'Cloud',
                'description' => $meta['description'] ?? '',
                'icon' => $meta['icon'] ?? 'server',
                'is_active' => (bool) $p->is_active,
                'is_configured' => (bool) $p->is_configured,
                'status' => $p->status,
                'last_tested_at' => $p->last_tested_at?->toISOString(),
                'last_error' => $p->last_error,
                'settings' => $p->settings ?? [],
                'credentials' => $p->getMaskedCredentials(),
                'fields' => $meta['fields'] ?? [],
            ];
        });

        return response()->json(['data' => $result]);
    }

    public function showProvider(Request $request, string $key): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $provider = StorageProvider::query()->where('provider_key', $key)->firstOrFail();
        $meta = StorageProviderRegistry::get($key) ?? [];

        return response()->json([
            'data' => [
                'id' => $provider->id,
                'provider_key' => $provider->provider_key,
                'name' => $provider->name,
                'driver_type' => $provider->driver_type,
                'category' => $meta['category'] ?? 'Cloud',
                'description' => $meta['description'] ?? '',
                'icon' => $meta['icon'] ?? 'server',
                'is_active' => (bool) $provider->is_active,
                'is_configured' => (bool) $provider->is_configured,
                'status' => $provider->status,
                'last_tested_at' => $provider->last_tested_at?->toISOString(),
                'last_error' => $provider->last_error,
                'settings' => $provider->settings ?? [],
                'credentials' => $provider->getMaskedCredentials(),
                'fields' => $meta['fields'] ?? [],
            ],
        ]);
    }

    public function updateProvider(Request $request, string $key): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $validated = $request->validate([
            'config' => ['required', 'array'],
        ]);

        $provider = $this->storageManager->saveProviderConfig(
            $key,
            $validated['config'],
            $request->user()
        );

        return response()->json([
            'message' => "Configuration for {$provider->name} saved.",
            'data' => [
                'provider_key' => $provider->provider_key,
                'is_configured' => (bool) $provider->is_configured,
                'status' => $provider->status,
                'credentials' => $provider->getMaskedCredentials(),
            ],
        ]);
    }

    public function testConnection(Request $request, string $key): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $result = $this->storageManager->testConnection($key);

        $status = $result['success'] ? 200 : 422;
        return response()->json([
            'data' => $result,
        ], $status);
    }

    public function activate(Request $request, string $key): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $provider = $this->storageManager->setActiveProvider($key, $request->user());

        return response()->json([
            'message' => "{$provider->name} is now the active primary storage provider.",
            'data' => [
                'active_provider' => $provider->provider_key,
                'is_active' => true,
            ],
        ]);
    }

    public function disconnect(Request $request, string $key): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $provider = $this->storageManager->disconnectProvider($key, $request->user());

        return response()->json([
            'message' => "{$provider->name} disconnected successfully.",
            'data' => [
                'provider_key' => $provider->provider_key,
                'is_configured' => false,
                'status' => 'not_configured',
            ],
        ]);
    }

    public function documents(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $query = StorageDocument::query()->with('user:id,name,email');

        if ($request->filled('provider_key')) {
            $query->where('provider_key', $request->query('provider_key'));
        }

        if ($request->filled('collection')) {
            $query->where('collection', $request->query('collection'));
        }

        if ($request->filled('search')) {
            $search = '%' . $request->query('search') . '%';
            $query->where(function ($q) use ($search) {
                $q->where('original_name', 'like', $search)
                  ->orWhere('file_path', 'like', $search);
            });
        }

        $documents = $query->latest('id')->paginate(15);

        return response()->json($documents);
    }

    public function uploadDocument(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $request->validate([
            'file' => ['required', 'file', 'max:15360'], // 15MB
            'collection' => ['sometimes', 'string', 'max:50'],
            'owner_id' => ['sometimes', 'nullable', 'integer', 'exists:users,id'],
        ]);

        $owner = $request->filled('owner_id')
            ? \App\Models\User::find($request->input('owner_id'))
            : null;

        $collection = $request->input('collection', 'general');

        $doc = $this->storageManager->upload(
            $request->file('file'),
            $collection,
            $owner,
            ['uploaded_via' => 'admin_panel'],
            $request->user()
        );

        return response()->json([
            'message' => 'Document uploaded successfully.',
            'data' => $doc,
        ], 201);
    }

    public function downloadDocument(Request $request, StorageDocument $document): StreamedResponse
    {
        if ($request->has('signature') || $request->routeIs('*signed*')) {
            abort_unless($request->hasValidSignature(), 403, 'Invalid or expired download signature.');
        } else {
            $this->authoriseSuperAdmin($request);
        }

        $fileData = $this->storageManager->getDocumentContent($document, $request->user());

        return response()->stream(function () use ($fileData) {
            echo $fileData['content'];
        }, 200, [
            'Content-Type' => $fileData['mime'],
            'Content-Length' => $fileData['size'],
            'Content-Disposition' => 'attachment; filename="' . addslashes($fileData['filename']) . '"',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    public function signedUrl(Request $request, StorageDocument $document): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $url = $this->storageManager->getTemporaryUrl($document, 15);

        return response()->json([
            'data' => [
                'url' => $url,
                'expires_in_minutes' => 15,
            ],
        ]);
    }

    public function deleteDocument(Request $request, StorageDocument $document): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $this->storageManager->deleteDocument($document, $request->user());

        return response()->json([
            'message' => 'Document deleted successfully.',
        ]);
    }

    public function logs(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $query = StorageLog::query()->with('user:id,name,email');

        if ($request->filled('provider_key')) {
            $query->where('provider_key', $request->query('provider_key'));
        }

        if ($request->filled('action')) {
            $query->where('action', $request->query('action'));
        }

        if ($request->filled('status')) {
            $query->where('status', $request->query('status'));
        }

        $logs = $query->latest('id')->paginate(20);

        return response()->json($logs);
    }

    private function authoriseSuperAdmin(Request $request): void
    {
        abort_unless($request->user()?->isSuperAdmin(), 403, 'Unauthorized. Super Admin access required.');
    }
}
