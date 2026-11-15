<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('reviews', function (Blueprint $table) {
            $table->id();
            $table->foreignId('student_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('teacher_id')->constrained('users')->restrictOnDelete();
            $table->foreignId('booking_id')->nullable()->unique()
                ->constrained('bookings')->restrictOnDelete();
            $table->unsignedTinyInteger('rating');
            $table->string('text', 600);
            $table->enum('status', ['published', 'hidden', 'flagged'])->default('published');
            $table->string('moderation_note', 400)->nullable();
            $table->foreignId('moderated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('moderated_at')->nullable();
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
            $table->unique(['student_id', 'teacher_id'], 'reviews_student_teacher_unique');
            $table->index(['teacher_id', 'status']);
            $table->index('rating');
        });

        DB::statement('ALTER TABLE reviews ADD CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5)');
        DB::statement(
            'ALTER TABLE reviews ADD CONSTRAINT reviews_text_length_check '
            .'CHECK (CHAR_LENGTH(text) BETWEEN 20 AND 600)'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('reviews');
    }
};
