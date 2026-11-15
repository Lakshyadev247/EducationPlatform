<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * A review belongs to one completed lesson.
     *
     * The old rule was one review per student and teacher, which meant a
     * student could never review the same teacher again for a later lesson.
     * The unique key on (student, teacher) is dropped, the existing unique key
     * on booking_id already prevents two reviews for the same lesson, and the
     * lesson reference becomes mandatory.
     */
    public function up(): void
    {
        // MySQL backs the foreign keys with the leftmost index, so the
        // (student, teacher) unique key cannot simply be dropped. A plain index
        // on student_id is created first to take over that job.
        Schema::table('reviews', function (Blueprint $table): void {
            $table->index('student_id', 'reviews_student_id_index');
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->dropUnique('reviews_student_teacher_unique');
        });

        // MySQL will not modify a column that a foreign key depends on, so
        // the constraint is dropped and restored around the change.
        Schema::table('reviews', function (Blueprint $table): void {
            $table->dropForeign(['booking_id']);
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->unsignedBigInteger('booking_id')->nullable(false)->change();
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->foreign('booking_id')->references('id')->on('bookings')->restrictOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('reviews', function (Blueprint $table): void {
            $table->dropForeign(['booking_id']);
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->unsignedBigInteger('booking_id')->nullable()->change();
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->foreign('booking_id')->references('id')->on('bookings')->restrictOnDelete();
        });

        Schema::table('reviews', function (Blueprint $table): void {
            $table->unique(['student_id', 'teacher_id'], 'reviews_student_teacher_unique');
        });

        // The replacement index is only dropped once the unique key is back.
        Schema::table('reviews', function (Blueprint $table): void {
            $table->dropIndex('reviews_student_id_index');
        });
    }
};
