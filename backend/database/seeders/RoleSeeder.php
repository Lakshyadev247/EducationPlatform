<?php

namespace Database\Seeders;

use App\Models\Role;
use Illuminate\Database\Seeder;

class RoleSeeder extends Seeder
{
    public function run(): void
    {
        $roles = [
            [Role::STUDENT, 'Student', 10, false],
            [Role::TEACHER, 'Teacher', 20, false],
            [Role::ADMIN, 'Admin', 80, true],
            [Role::SUPER_ADMIN, 'Super Admin', 100, true],
        ];

        foreach ($roles as [$name, $label, $rank, $isPrivileged]) {
            Role::updateOrCreate(
                ['name' => $name],
                [
                    'label' => $label,
                    'rank' => $rank,
                    'is_privileged' => $isPrivileged,
                ]
            );
        }
    }
}
