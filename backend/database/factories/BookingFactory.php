<?php

namespace Database\Factories;

use App\Models\Booking;
use App\Models\Subject;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Booking>
 */
class BookingFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $startTime = fake()->randomElement(['08:00:00', '09:00:00', '10:00:00', '16:00:00', '17:00:00']);

        return [
            'reference' => 'BK-'.Str::ulid(),
            'student_id' => User::factory(),
            'teacher_id' => User::factory(),
            'subject_id' => Subject::factory(),
            'booking_date' => fake()->dateTimeBetween('+1 day', '+30 days')->format('Y-m-d'),
            'start_time' => $startTime,
            'end_time' => date('H:i:s', strtotime($startTime) + 3600),
            'duration_minutes' => 60,
            'teaching_mode' => fake()->randomElement(['online', 'in-person']),
            'status' => Booking::STATUS_PENDING,
            'message' => fake()->sentence(8),
            'rejection_reason' => null,
            'decided_at' => null,
            'cancelled_at' => null,
            'cancelled_by' => null,
            'completed_at' => null,
        ];
    }

    public function accepted(): static
    {
        return $this->state(fn (array $attributes): array => [
            'status' => Booking::STATUS_ACCEPTED,
            'decided_at' => now(),
        ]);
    }

    public function cancelled(): static
    {
        return $this->state(fn (array $attributes): array => [
            'status' => Booking::STATUS_CANCELLED,
            'cancelled_at' => now(),
        ]);
    }
}
