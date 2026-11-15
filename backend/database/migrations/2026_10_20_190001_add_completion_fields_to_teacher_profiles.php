<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('teacher_profiles', function (Blueprint $table): void {
            $table->string('level_other', 80)->nullable()->after('experience_level');
            $table->timestamp('completed_at')->nullable()->after('is_public');
        });
    }

    public function down(): void
    {
        Schema::table('teacher_profiles', function (Blueprint $table): void {
            $table->dropColumn(['level_other', 'completed_at']);
        });
    }
};
