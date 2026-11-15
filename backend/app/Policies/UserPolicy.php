<?php

namespace App\Policies;

use App\Models\Role;
use App\Models\User;

class UserPolicy
{
    public function viewAny(User $actor): bool
    {
        return $actor->isAdmin();
    }

    public function create(User $actor, string $roleName): bool
    {
        $role = Role::query()->where('name', $roleName)->first();

        if ($role === null) {
            return false;
        }

        if ($actor->isSuperAdmin()) {
            return true;
        }

        return $actor->hasRole(Role::ADMIN) && ! $role->is_privileged;
    }

    public function assignRole(User $actor, User $target, Role $role): bool
    {
        if ($actor->isSuperAdmin()) {
            return true;
        }

        if (! $actor->hasRole(Role::ADMIN)) {
            return false;
        }

        if ($target->isAdmin()) {
            return false;
        }

        return ! $role->is_privileged;
    }
}
