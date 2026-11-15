<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('storage_logs');
        Schema::dropIfExists('storage_documents');
        Schema::dropIfExists('storage_providers');

        Schema::create('storage_providers', function (Blueprint $table) {
            $table->id();
            $table->string('provider_key', 40)->unique();
            $table->string('name', 100);
            $table->string('driver_type', 40)->default('s3_compatible');
            $table->boolean('is_active')->default(false)->index();
            $table->boolean('is_configured')->default(false);
            $table->longText('credentials')->nullable();
            $table->json('settings')->nullable();
            $table->string('status', 30)->default('not_configured'); // not_configured, connected, error
            $table->timestamp('last_tested_at')->nullable();
            $table->text('last_error')->nullable();
            $table->json('metadata')->nullable();
            $table->timestamps();
        });

        Schema::create('storage_documents', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->foreignId('user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('provider_key', 40)->index();
            $table->string('collection', 50)->default('general')->index();
            $table->string('original_name', 255);
            $table->string('file_path', 500);
            $table->string('mime_type', 100);
            $table->unsignedBigInteger('file_size')->default(0);
            $table->string('checksum', 64)->nullable();
            $table->json('metadata')->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::create('storage_logs', function (Blueprint $table) {
            $table->id();
            $table->string('provider_key', 40)->index();
            $table->string('action', 40); // upload, download, delete, test_connection, switch_active, configure, disconnect
            $table->string('status', 20); // success, failure
            $table->foreignId('document_id')->nullable()->constrained('storage_documents')->nullOnDelete();
            $table->string('file_name', 255)->nullable();
            $table->unsignedBigInteger('file_size')->nullable();
            $table->integer('duration_ms')->nullable();
            $table->text('message')->nullable();
            $table->foreignId('user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('created_at')->useCurrent();
        });

        // Seed default 9 supported providers
        $now = now();
        $defaults = [
            [
                'provider_key' => 'local',
                'name' => 'Local Server Storage',
                'driver_type' => 'local',
                'is_active' => true,
                'is_configured' => true,
                'status' => 'connected',
                'settings' => json_encode(['root' => 'documents']),
                'last_tested_at' => $now,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'cloudflare_r2',
                'name' => 'Cloudflare R2',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'auto']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 's3',
                'name' => 'Amazon S3',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'ap-south-1']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'gcs',
                'name' => 'Google Cloud Storage',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'auto', 'endpoint' => 'https://storage.googleapis.com']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'azure',
                'name' => 'Microsoft Azure Blob Storage',
                'driver_type' => 'azure',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode([]),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'digitalocean',
                'name' => 'DigitalOcean Spaces',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'blr1']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'backblaze',
                'name' => 'Backblaze B2',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'us-east-005']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'wasabi',
                'name' => 'Wasabi Cloud Storage',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'ap-northeast-1']),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            [
                'provider_key' => 'minio',
                'name' => 'MinIO (Self-Hosted)',
                'driver_type' => 's3_compatible',
                'is_active' => false,
                'is_configured' => false,
                'status' => 'not_configured',
                'settings' => json_encode(['region' => 'us-east-1', 'use_path_style_endpoint' => true]),
                'last_tested_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ],
        ];

        DB::table('storage_providers')->insert($defaults);
    }

    public function down(): void
    {
        Schema::dropIfExists('storage_logs');
        Schema::dropIfExists('storage_documents');
        Schema::dropIfExists('storage_providers');
    }
};
