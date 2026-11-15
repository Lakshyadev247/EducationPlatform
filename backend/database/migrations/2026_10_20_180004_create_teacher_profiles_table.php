<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('teacher_profiles', function (Blueprint $table) {
            $table->foreignId('user_id')->primary()->constrained()->cascadeOnDelete();
            $table->string('bio', 300)->nullable();
            $table->string('photo_path', 255)->nullable();
            $table->string('experience_level', 40)->nullable();
            $table->decimal('experience_years', 4, 1)->nullable();
            $table->string('experience_org', 160)->nullable();
            $table->string('experience_description', 240)->nullable();
            $table->enum('teaching_mode', ['online', 'in-person', 'both'])->nullable();
            $table->string('online_tools', 160)->nullable();
            $table->string('timezone', 64)->default('Asia/Kolkata');
            $table->enum('approval_status', ['pending', 'approved', 'rejected'])->default('pending');
            $table->timestamp('approved_at')->nullable();
            $table->foreignId('approved_by')->nullable()->constrained('users')->nullOnDelete();
            $table->boolean('is_public')->default(false);
            $table->timestamps();
            $table->index('teaching_mode');
            $table->index('approval_status');
            $table->index(['is_public', 'approval_status']);
        });

        DB::statement(
            'ALTER TABLE teacher_profiles ADD CONSTRAINT teacher_profiles_experience_years_check '
            .'CHECK (experience_years IS NULL OR (experience_years >= 0 AND experience_years <= 60))'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('teacher_profiles');
    }
};
