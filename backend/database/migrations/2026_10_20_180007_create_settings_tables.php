<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('settings', function (Blueprint $table) {
            $table->id();
            $table->string('key', 120)->unique();
            $table->string('group', 60);
            $table->json('value')->nullable();
            $table->string('type', 20)->default('json');
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->index('group');
        });

        Schema::create('teacher_setting_overrides', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->string('group', 60);
            $table->string('key', 80);
            $table->json('value')->nullable();
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->unique(
                ['teacher_profile_id', 'group', 'key'],
                'teacher_setting_overrides_unique'
            );
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('teacher_setting_overrides');
        Schema::dropIfExists('settings');
    }
};
