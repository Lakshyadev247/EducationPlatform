<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('bookings', function (Blueprint $table) {
            $table->id();
            $table->string('reference', 32)->unique();
            $table->foreignId('student_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('teacher_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('subject_id')->constrained()->restrictOnDelete();
            $table->date('booking_date');
            $table->time('start_time');
            $table->time('end_time')->nullable();
            $table->unsignedSmallInteger('duration_minutes')->default(60);
            $table->enum('teaching_mode', ['online', 'in-person']);
            $table->enum('status', ['pending', 'accepted', 'rejected', 'cancelled', 'completed'])
                ->default('pending');
            $table->string('message', 300)->nullable();
            $table->string('rejection_reason', 400)->nullable();
            $table->timestamp('decided_at')->nullable();
            $table->timestamp('cancelled_at')->nullable();
            $table->foreignId('cancelled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('completed_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->tinyInteger('active_flag')
                ->nullable()
                ->storedAs("case when status in ('pending', 'accepted') and deleted_at is null then 1 else null end");

            $table->index(['student_id', 'status']);
            $table->index(['teacher_id', 'status']);
            $table->index('booking_date');
            $table->unique(
                ['teacher_id', 'booking_date', 'start_time', 'active_flag'],
                'bookings_teacher_active_slot_unique'
            );
            $table->unique(
                ['student_id', 'teacher_id', 'booking_date', 'start_time', 'active_flag'],
                'bookings_student_active_slot_unique'
            );
        });

        DB::statement(
            'ALTER TABLE bookings ADD CONSTRAINT bookings_duration_check CHECK (duration_minutes > 0)'
        );
        DB::statement(
            'ALTER TABLE bookings ADD CONSTRAINT bookings_time_check '
            .'CHECK (end_time IS NULL OR end_time > start_time)'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('bookings');
    }
};
