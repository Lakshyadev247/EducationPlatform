<?php

namespace Database\Seeders;

use App\Models\EducationLevel;
use App\Models\Stream;
use App\Models\Subject;
use Illuminate\Database\Seeder;
use Illuminate\Support\Str;

class ReferenceDataSeeder extends Seeder
{
    public function run(): void
    {
        $levels = [
            ['1-5', 'Classes 1-5', 10],
            ['6-8', 'Classes 6-8', 20],
            ['9-10', 'Classes 9-10', 30],
            ['11-12', 'Classes 11-12', 40],
            ['college', 'College / University', 45],
            ['other', 'Other level', 50],
        ];

        foreach ($levels as [$key, $label, $sortOrder]) {
            EducationLevel::updateOrCreate(
                ['key' => $key],
                ['label' => $label, 'sort_order' => $sortOrder, 'is_active' => true]
            );
        }

        $streams = [
            ['science', 'Science', 10],
            ['commerce', 'Commerce', 20],
            ['arts', 'Arts / Humanities', 30],
        ];

        foreach ($streams as [$key, $label, $sortOrder]) {
            Stream::updateOrCreate(
                ['key' => $key],
                ['label' => $label, 'sort_order' => $sortOrder, 'is_active' => true]
            );
        }

        $subjects = [
            'Mathematics',
            'Science',
            'Physics',
            'Chemistry',
            'Biology',
            'English',
            'Hindi',
            'Computer Science',
            'Social Studies',
            'Economics',
        ];

        foreach ($subjects as $index => $name) {
            Subject::updateOrCreate(
                ['slug' => Str::slug($name)],
                [
                    'name' => $name,
                    'sort_order' => ($index + 1) * 10,
                    'is_active' => true,
                ]
            );
        }
    }
}
