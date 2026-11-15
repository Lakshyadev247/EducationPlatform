<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('teacher_subjects', function (Blueprint $table) {
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->foreignId('subject_id')->constrained()->restrictOnDelete();
            $table->primary(['teacher_profile_id', 'subject_id']);
            $table->index('subject_id');
        });

        Schema::create('teacher_education_levels', function (Blueprint $table) {
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->foreignId('education_level_id')->constrained()->restrictOnDelete();
            $table->primary(['teacher_profile_id', 'education_level_id']);
            $table->index('education_level_id');
        });

        Schema::create('teacher_streams', function (Blueprint $table) {
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->foreignId('stream_id')->constrained()->restrictOnDelete();
            $table->primary(['teacher_profile_id', 'stream_id']);
            $table->index('stream_id');
        });

        Schema::create('teacher_qualifications', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->string('name', 160);
            $table->string('institution', 160)->nullable();
            $table->unsignedSmallInteger('year_completed')->nullable();
            $table->timestamps();
            $table->index('teacher_profile_id');
        });

        DB::statement(
            'ALTER TABLE teacher_qualifications ADD CONSTRAINT teacher_qualifications_year_check '
            .'CHECK (year_completed IS NULL OR (year_completed >= 1900 AND year_completed <= 2100))'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('teacher_qualifications');
        Schema::dropIfExists('teacher_streams');
        Schema::dropIfExists('teacher_education_levels');
        Schema::dropIfExists('teacher_subjects');
    }
};
