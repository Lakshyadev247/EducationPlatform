<?php

namespace Database\Factories;

use App\Models\Review;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Review>
 */
class ReviewFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'student_id' => User::factory(),
            'teacher_id' => User::factory(),
            'booking_id' => null,
            'rating' => fake()->numberBetween(3, 5),
            'text' => fake()->paragraph(2),
            'status' => 'published',
            'moderation_note' => null,
            'moderated_by' => null,
            'moderated_at' => null,
            'published_at' => now(),
        ];
    }
}
