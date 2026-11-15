<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('terms_versions', function (Blueprint $table) {
            $table->id();
            $table->enum('audience', ['common', 'student', 'teacher']);
            $table->string('version', 40);
            $table->string('title', 160);
            $table->longText('body');
            $table->date('effective_date');
            $table->foreignId('published_by')->constrained('users')->restrictOnDelete();
            $table->timestamp('published_at');
            $table->boolean('is_current')->default(false);
            $table->timestamps();
            $table->unique(['audience', 'version'], 'terms_versions_audience_version_unique');
            $table->index(['audience', 'is_current']);
        });

        Schema::create('terms_acceptances', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->restrictOnDelete();
            $table->foreignId('terms_version_id')->constrained('terms_versions')->restrictOnDelete();
            $table->string('role_at_acceptance', 40);
            $table->timestamp('accepted_at');
            $table->timestamps();
            $table->unique(['user_id', 'terms_version_id'], 'terms_acceptances_user_version_unique');
            $table->index('terms_version_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('terms_acceptances');
        Schema::dropIfExists('terms_versions');
    }
};
