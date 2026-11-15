<?php

namespace Database\Factories;

use App\Models\StudentProfile;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<StudentProfile>
 */
class StudentProfileFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'education_level_id' => null,
            'level_other' => null,
            'intro' => fake()->sentence(10),
            'photo_path' => null,
            'completed_at' => now(),
        ];
    }
}
