<?php

namespace App\Services\Storage;

use App\Models\StorageProvider;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Storage;
use League\Flysystem\Filesystem as FlysystemFilesystem;

class StorageDiskFactory
{
    /**
     * Create a Laravel filesystem disk instance for a given StorageProvider model.
     */
    public function make(StorageProvider $provider): Filesystem
    {
        $key = $provider->provider_key;
        $driver = $provider->driver_type;
        $creds = $provider->getDecryptedCredentials();
        $settings = $provider->settings ?? [];

        if ($driver === 'local' || $key === 'local') {
            $folder = $settings['root'] ?? ($creds['root'] ?? 'documents');
            $folder = trim($folder, '/\\');
            $rootPath = storage_path('app/private/' . ($folder ?: 'documents'));

            if (!is_dir($rootPath)) {
                @mkdir($rootPath, 0755, true);
            }

            return Storage::build([
                'driver' => 'local',
                'root' => $rootPath,
                'throw' => true,
            ]);
        }

        if ($driver === 'azure' || $key === 'azure') {
            $accountName = $creds['account_name'] ?? ($settings['account_name'] ?? '');
            $accountKey = $creds['account_key'] ?? ($settings['account_key'] ?? '');
            $container = $settings['container'] ?? ($creds['container'] ?? '');
            $endpoint = $settings['endpoint'] ?? ($creds['endpoint'] ?? null);

            $adapter = new AzureBlobFilesystemAdapter(
                $accountName,
                $accountKey,
                $container,
                $endpoint
            );

            $flysystem = new FlysystemFilesystem($adapter);
            return new FilesystemAdapter($flysystem, $adapter, [
                'driver' => 'azure',
                'container' => $container,
            ]);
        }

        // S3-compatible providers (Cloudflare R2, S3, GCS, DigitalOcean, Backblaze, Wasabi, MinIO)
        $accessKey = $creds['access_key_id'] ?? ($settings['access_key_id'] ?? '');
        $secretKey = $creds['secret_access_key'] ?? ($settings['secret_access_key'] ?? '');
        $bucket = $settings['bucket'] ?? ($creds['bucket'] ?? '');
        $region = $settings['region'] ?? ($creds['region'] ?? 'us-east-1');
        $endpoint = $settings['endpoint'] ?? ($creds['endpoint'] ?? null);
        $usePathStyle = (bool) ($settings['use_path_style_endpoint'] ?? ($creds['use_path_style_endpoint'] ?? false));

        // Auto-generate endpoints if not specified:
        if (empty($endpoint)) {
            if ($key === 'cloudflare_r2') {
                $accountId = $settings['account_id'] ?? ($creds['account_id'] ?? '');
                $endpoint = "https://{$accountId}.r2.cloudflarestorage.com";
            } elseif ($key === 'digitalocean') {
                $endpoint = "https://{$region}.digitaloceanspaces.com";
            } elseif ($key === 'backblaze') {
                $endpoint = "https://s3.{$region}.backblazeb2.com";
            } elseif ($key === 'wasabi') {
                $endpoint = "https://s3.{$region}.wasabisys.com";
            } elseif ($key === 'gcs') {
                $endpoint = 'https://storage.googleapis.com';
            }
        }

        if ($key === 'cloudflare_r2') {
            $region = $region ?: 'auto';
            $usePathStyle = false;
        }

        if ($key === 'minio') {
            $usePathStyle = true;
        }

        return Storage::build([
            'driver' => 's3',
            'key' => $accessKey,
            'secret' => $secretKey,
            'region' => $region ?: 'us-east-1',
            'bucket' => $bucket,
            'endpoint' => $endpoint ?: null,
            'use_path_style_endpoint' => $usePathStyle,
            'throw' => true,
        ]);
    }
}
