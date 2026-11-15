<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('teacher_service_locations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->string('area', 120)->nullable();
            $table->string('city', 120);
            $table->string('state', 120);
            $table->string('country', 80);
            $table->unsignedSmallInteger('teaching_radius_km')->nullable();
            $table->boolean('is_primary')->default(true);
            $table->timestamps();
            $table->index(['city', 'state']);
            $table->index(['teacher_profile_id', 'is_primary']);
        });

        Schema::create('teacher_availability', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->unsignedTinyInteger('day_of_week');
            $table->time('start_time');
            $table->time('end_time');
            $table->timestamps();
            $table->unique(
                ['teacher_profile_id', 'day_of_week', 'start_time', 'end_time'],
                'teacher_availability_slot_unique'
            );
        });

        Schema::create('teacher_prices', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->enum('pricing_type', ['hourly', 'monthly', 'course']);
            $table->decimal('amount', 10, 2);
            $table->char('currency', 3)->default('INR');
            $table->timestamps();
            $table->unique(['teacher_profile_id', 'pricing_type'], 'teacher_prices_type_unique');
        });

        Schema::create('platform_holidays', function (Blueprint $table) {
            $table->id();
            $table->date('holiday_date')->unique();
            $table->string('name', 120);
            $table->string('description', 255)->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::create('teacher_unavailable_dates', function (Blueprint $table) {
            $table->id();
            $table->foreignId('teacher_profile_id')->constrained('teacher_profiles', 'user_id')->cascadeOnDelete();
            $table->date('unavailable_date');
            $table->string('reason', 255)->nullable();
            $table->timestamps();
            $table->unique(
                ['teacher_profile_id', 'unavailable_date'],
                'teacher_unavailable_dates_unique'
            );
        });

        DB::statement(
            'ALTER TABLE teacher_service_locations ADD CONSTRAINT teacher_service_radius_check '
            .'CHECK (teaching_radius_km IS NULL OR teaching_radius_km <= 500)'
        );
        DB::statement(
            'ALTER TABLE teacher_availability ADD CONSTRAINT teacher_availability_day_check '
            .'CHECK (day_of_week BETWEEN 0 AND 6)'
        );
        DB::statement(
            'ALTER TABLE teacher_availability ADD CONSTRAINT teacher_availability_time_check '
            .'CHECK (start_time < end_time)'
        );
        DB::statement(
            'ALTER TABLE teacher_prices ADD CONSTRAINT teacher_prices_amount_check CHECK (amount > 0)'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('teacher_unavailable_dates');
        Schema::dropIfExists('platform_holidays');
        Schema::dropIfExists('teacher_prices');
        Schema::dropIfExists('teacher_availability');
        Schema::dropIfExists('teacher_service_locations');
    }
};
