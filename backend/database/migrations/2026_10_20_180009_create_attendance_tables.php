<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('attendance_records', function (Blueprint $table) {
            $table->id();
            $table->foreignId('booking_id')->unique()->constrained()->restrictOnDelete();
            $table->foreignId('teacher_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('student_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('marked_by')->constrained('users')->restrictOnDelete();
            $table->enum('result', ['present', 'absent']);
            $table->enum('current_result', ['present', 'absent']);
            $table->string('absence_reason', 240)->nullable();
            $table->timestamp('marked_at');
            $table->enum('confirmation', ['pending', 'confirmed', 'disputed'])->default('pending');
            $table->string('student_response', 400)->nullable();
            $table->timestamp('responded_at')->nullable();
            $table->timestamp('resolved_at')->nullable();
            $table->timestamps();
            $table->index(['teacher_id', 'confirmation']);
            $table->index(['student_id', 'confirmation']);
        });

        Schema::create('attendance_corrections', function (Blueprint $table) {
            $table->id();
            $table->foreignId('attendance_id')->constrained('attendance_records')->restrictOnDelete();
            $table->foreignId('requester_id')->constrained('users')->restrictOnDelete();
            $table->enum('requester_role', ['student', 'teacher']);
            $table->string('explanation', 400);
            $table->enum('status', ['pending', 'approved', 'rejected', 'upheld'])->default('pending');
            $table->timestamp('resolved_at')->nullable();
            $table->foreignId('resolved_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->tinyInteger('open_flag')
                ->nullable()
                ->storedAs("case when status = 'pending' then 1 else null end");

            $table->index('status');
            $table->unique(
                ['attendance_id', 'requester_id', 'open_flag'],
                'attendance_corrections_open_unique'
            );
        });

        Schema::create('attendance_decisions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('attendance_id')->constrained('attendance_records')->restrictOnDelete();
            $table->foreignId('correction_id')->nullable()
                ->constrained('attendance_corrections')->restrictOnDelete();
            $table->foreignId('reviewer_id')->constrained('users')->restrictOnDelete();
            $table->enum('decision_type', ['uphold', 'approve-correction', 'reject-correction', 'keep-pending']);
            $table->enum('original_result', ['present', 'absent']);
            $table->enum('final_result', ['present', 'absent']);
            $table->string('reason', 400);
            $table->timestamp('decided_at');
            $table->timestamp('created_at')->useCurrent();
            $table->index(['attendance_id', 'decided_at']);
            $table->index('reviewer_id');
        });

        DB::statement(
            'ALTER TABLE attendance_records ADD CONSTRAINT attendance_absence_reason_check '
            .'CHECK (result <> \'absent\' OR absence_reason IS NOT NULL)'
        );
        DB::statement(
            'ALTER TABLE attendance_records ADD CONSTRAINT attendance_dispute_response_check '
            .'CHECK (confirmation <> \'disputed\' OR student_response IS NOT NULL)'
        );
        DB::statement(
            'ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_explanation_check '
            .'CHECK (CHAR_LENGTH(explanation) > 0)'
        );
        DB::statement(
            'ALTER TABLE attendance_decisions ADD CONSTRAINT attendance_decisions_reason_check '
            .'CHECK (CHAR_LENGTH(reason) > 0)'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('attendance_decisions');
        Schema::dropIfExists('attendance_corrections');
        Schema::dropIfExists('attendance_records');
    }
};
