<?php

namespace Database\Factories;

use App\Models\TeacherProfile;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<TeacherProfile>
 */
class TeacherProfileFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'bio' => fake()->sentence(14),
            'photo_path' => null,
            'experience_level' => fake()->randomElement(['0-2 years', '2-5 years', '5-10 years', '10+ years']),
            'experience_years' => fake()->randomFloat(1, 0, 20),
            'experience_org' => fake()->company(),
            'experience_description' => fake()->sentence(10),
            'teaching_mode' => fake()->randomElement(['online', 'in-person', 'both']),
            'online_tools' => 'Google Meet',
            'timezone' => 'Asia/Kolkata',
            'approval_status' => 'approved',
            'approved_at' => now(),
            'approved_by' => null,
            'is_public' => true,
        ];
    }

    public function pending(): static
    {
        return $this->state(fn (array $attributes): array => [
            'approval_status' => 'pending',
            'approved_at' => null,
            'is_public' => false,
        ]);
    }
}
