<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('teacher_profiles', function (Blueprint $table): void {
            $table->foreignId('id_document_id')->nullable()->constrained('storage_documents')->nullOnDelete();
            $table->foreignId('qualification_document_id')->nullable()->constrained('storage_documents')->nullOnDelete();
            $table->string('document_verification_status', 30)->default('not_uploaded')->index();
            $table->timestamp('document_verified_at')->nullable();
            $table->foreignId('document_verified_by')->nullable()->constrained('users')->nullOnDelete();
            $table->text('document_rejection_reason')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('teacher_profiles', function (Blueprint $table): void {
            $table->dropForeign(['id_document_id']);
            $table->dropForeign(['qualification_document_id']);
            $table->dropForeign(['document_verified_by']);
            $table->dropColumn([
                'id_document_id',
                'qualification_document_id',
                'document_verification_status',
                'document_verified_at',
                'document_verified_by',
                'document_rejection_reason',
            ]);
        });
    }
};
