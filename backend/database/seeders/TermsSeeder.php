<?php

namespace Database\Seeders;

use App\Models\TermsVersion;
use Carbon\Carbon;
use Illuminate\Database\Seeder;

class TermsSeeder extends Seeder
{
    public function run(): void
    {
        $adminId = \App\Models\User::whereHas('roles', fn ($q) => $q->whereIn('name', ['admin', 'super-admin', 'super_admin']))->value('id');

        if (!$adminId) {
            $adminId = \App\Models\User::value('id');
        }

        if (!$adminId) {
            $adminUser = \App\Models\User::create([
                'name' => 'System Administrator',
                'email' => 'admin@example.com',
                'password' => \Illuminate\Support\Facades\Hash::make('SystemAdmin2026!'),
                'status' => 'active',
            ]);
            $adminRole = \App\Models\Role::firstOrCreate(
                ['name' => 'admin'],
                ['label' => 'Admin', 'rank' => 80, 'is_privileged' => true]
            );
            $adminUser->roles()->syncWithoutDetaching([$adminRole->id]);
            $adminId = $adminUser->id;
        }

        $docs = [
            [
                'audience' => 'student',
                'version' => '1.0.0',
                'title' => 'Student Terms of Service & Learning Policy',
                'body' => "# Welcome to the Platform\n\nThese terms outline the rules and expectations for students using the platform.\n\n* **Lesson Attendance**: Attend scheduled online or in-person lessons punctually.\n* **Mutual Confirmation**: Verify and confirm completed lessons in your attendance records.\n* **Communication**: All tuition requests and package arrangements are coordinated via authorized platform channels.\n* **Respect & Conduct**: Treat teachers, coordinators, and fellow students with mutual dignity and respect.",
                'effective_date' => Carbon::today(),
                'published_at' => Carbon::now(),
                'published_by' => $adminId,
                'is_current' => true,
            ],
            [
                'audience' => 'teacher',
                'version' => '1.0.0',
                'title' => 'Teacher Agreement & Code of Conduct',
                'body' => "# Teacher Standards\n\n* **Professionalism**: Uphold highest teaching standards and deliver comprehensive syllabus coverage.\n* **Punctuality**: Conduct all accepted classes on time and log lesson completion promptly.\n* **Verification**: Keep qualification and identity records up to date for ongoing verification.",
                'effective_date' => Carbon::today(),
                'published_at' => Carbon::now(),
                'published_by' => $adminId,
                'is_current' => true,
            ],
            [
                'audience' => 'common',
                'version' => '1.0.0',
                'title' => 'Platform Terms & Conditions',
                'body' => "# General Platform Terms\n\n* **Account Security**: Protect your account credentials.\n* **Privacy**: We respect your personal data in accordance with our Privacy Policy.",
                'effective_date' => Carbon::today(),
                'published_at' => Carbon::now(),
                'published_by' => $adminId,
                'is_current' => true,
            ],
        ];

        foreach ($docs as $doc) {
            TermsVersion::updateOrCreate(
                ['audience' => $doc['audience'], 'version' => $doc['version']],
                $doc
            );
        }
    }
}
