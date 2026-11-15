<?php

namespace App\Console\Commands;

use App\Models\Role;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rules\Password;

#[Signature('app:create-super-admin {--name=} {--email=}')]
#[Description('Create or promote an explicit Super Admin account (interactive password).')]
class CreateSuperAdmin extends Command
{
    public function handle(AuditLogger $auditLogger): int
    {
        $name = $this->option('name') ?: $this->ask('Super Admin name');
        $email = $this->option('email') ?: $this->ask('Super Admin email');

        $identity = Validator::make(
            ['name' => $name, 'email' => $email],
            [
                'name' => ['required', 'string', 'max:120'],
                'email' => ['required', 'string', 'email', 'max:190'],
            ],
        );

        if ($identity->fails()) {
            foreach ($identity->errors()->all() as $error) {
                $this->error($error);
            }

            return self::FAILURE;
        }

        $password = $this->secret('Password (minimum 12 characters)');
        $confirmation = $this->secret('Confirm password');

        if ($password !== $confirmation) {
            $this->error('Passwords do not match.');

            return self::FAILURE;
        }

        $passwordCheck = Validator::make(
            ['password' => $password],
            ['password' => ['required', 'string', Password::min(12)]],
        );

        if ($passwordCheck->fails()) {
            foreach ($passwordCheck->errors()->all() as $error) {
                $this->error($error);
            }

            return self::FAILURE;
        }

        $user = DB::transaction(function () use ($auditLogger, $email, $name, $password): User {
            $role = Role::query()->updateOrCreate(
                ['name' => Role::SUPER_ADMIN],
                ['label' => 'Super Admin', 'rank' => 100, 'is_privileged' => true],
            );

            $user = User::withTrashed()->where('email', $email)->first();

            if ($user !== null) {
                if ($user->trashed()) {
                    $user->restore();
                }

                $user->forceFill([
                    'name' => $name,
                    'password' => $password,
                    'status' => 'active',
                ])->save();
            } else {
                $user = User::query()->create([
                    'name' => $name,
                    'email' => $email,
                    'password' => $password,
                    'status' => 'active',
                ]);

                // email_verified_at is deliberately not mass-assignable, so a
                // value passed to create() would be dropped silently. The
                // bootstrap administrator must not start life as unverified.
                $user->forceFill(['email_verified_at' => now()])->save();
            }

            $user->roles()->syncWithoutDetaching([
                $role->id => [
                    'assigned_by' => null,
                    'assigned_at' => now(),
                ],
            ]);

            $auditLogger->record(
                null,
                'super_admin.assigned',
                User::class,
                $user->id,
                [],
                ['email' => $user->email, 'role' => Role::SUPER_ADMIN],
                'Initial Super Admin created through the explicit Artisan command.',
            );

            return $user;
        });

        $this->info('Super Admin ready for '.$user->email.'. No password was stored in output or source control.');

        return self::SUCCESS;
    }
}
