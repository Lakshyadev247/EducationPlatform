<?php

namespace Database\Factories;

use App\Models\AttendanceRecord;
use App\Models\Booking;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<AttendanceRecord>
 */
class AttendanceRecordFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'booking_id' => Booking::factory(),
            'teacher_id' => User::factory(),
            'student_id' => User::factory(),
            'marked_by' => User::factory(),
            'result' => 'present',
            'current_result' => 'present',
            'absence_reason' => null,
            'marked_at' => now(),
            'confirmation' => AttendanceRecord::CONFIRMATION_PENDING,
            'student_response' => null,
            'responded_at' => null,
            'resolved_at' => null,
        ];
    }
}
