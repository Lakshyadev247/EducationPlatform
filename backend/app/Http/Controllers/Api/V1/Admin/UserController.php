<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreUserRequest;
use App\Http\Requests\UpdateUserRoleRequest;
use App\Http\Resources\UserResource;
use App\Models\Role;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

class UserController extends Controller
{
    public function index(Request $request): AnonymousResourceCollection
    {
        Gate::authorize('viewAny', User::class);

        $users = User::query()
            ->with('roles')
            ->orderBy('name')
            ->paginate(25);

        return UserResource::collection($users);
    }

    public function store(StoreUserRequest $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validated();
        $actor = $request->user();

        Gate::authorize('create', [User::class, $data['role']]);

        $role = Role::query()->where('name', $data['role'])->firstOrFail();

        $user = DB::transaction(function () use ($actor, $auditLogger, $data, $role): User {
            $user = User::query()->create([
                'name' => $data['name'],
                'email' => $data['email'],
                'phone' => $data['phone'] ?? null,
                'password' => $data['password'],
                'status' => 'active',
            ]);

            $user->roles()->attach($role->id, [
                'assigned_by' => $actor->id,
                'assigned_at' => now(),
            ]);

            $auditLogger->record(
                $actor,
                'user.created',
                User::class,
                $user->id,
                [],
                [
                    'name' => $user->name,
                    'email' => $user->email,
                    'role' => $role->name,
                ],
            );

            return $user;
        });

        return (new UserResource($user->load('roles')))
            ->response()
            ->setStatusCode(201);
    }

    public function updateRole(
        UpdateUserRoleRequest $request,
        User $user,
        AuditLogger $auditLogger,
    ): UserResource {
        $actor = $request->user();
        $role = Role::query()->where('name', $request->validated('role'))->firstOrFail();

        Gate::authorize('assignRole', [$user, $role]);

        DB::transaction(function () use ($actor, $auditLogger, $user, $role): void {
            $oldRoles = $user->roles()->pluck('name')->all();

            $user->roles()->sync([
                $role->id => [
                    'assigned_by' => $actor->id,
                    'assigned_at' => now(),
                ],
            ]);

            $auditLogger->record(
                $actor,
                'user.role_changed',
                User::class,
                $user->id,
                ['roles' => $oldRoles],
                ['roles' => [$role->name]],
            );
        });

        return new UserResource($user->fresh('roles'));
    }
}
