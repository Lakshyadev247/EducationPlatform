<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\StudentProfileResource;
use App\Http\Resources\TeacherResource;
use App\Http\Resources\UserResource;
use App\Models\User;
use App\Services\AccountSessionService;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Validation\Rule;

class DirectoryController extends Controller
{
    /**
     * @return AnonymousResourceCollection
     */
    public function users(Request $request)
    {
        $filters = $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'role' => ['nullable', 'string', Rule::exists('roles', 'name')],
            'status' => ['nullable', Rule::in(['active', 'suspended', 'closed'])],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        // Closed accounts are soft deleted, but an administrator still has to
        // be able to find them: the anonymised row is what the retained
        // bookings and the audit trail point at.
        $query = User::withTrashed()
            ->with(['roles', 'studentProfile.educationLevel', 'teacherProfile'])
            ->orderBy('name');

        if (! empty($filters['q'])) {
            $term = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], trim($filters['q'])).'%';
            $query->where(fn ($q) => $q->where('name', 'like', $term)->orWhere('email', 'like', $term));
        }

        if (! empty($filters['role'])) {
            $query->whereHas('roles', fn ($q) => $q->where('name', $filters['role']));
        }

        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        $users = $query->paginate((int) ($filters['per_page'] ?? 25));

        return response()->json([
            'data' => $users->getCollection()->map(fn (User $user): array => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'phone' => $user->phone,
                'status' => $user->status,
                'roles' => $user->roles->map(fn ($role): array => [
                    'name' => $role->name,
                    'label' => $role->label,
                    'rank' => $role->rank,
                ])->values(),
                'student_profile' => $user->studentProfile === null ? null : [
                    'level' => $user->studentProfile->educationLevel?->key,
                    'level_label' => $user->studentProfile->educationLevel?->label,
                    'completed' => $user->studentProfile->completed_at !== null,
                ],
                'teacher_profile' => $user->teacherProfile === null ? null : [
                    'approval_status' => $user->teacherProfile->approval_status,
                    'is_public' => (bool) $user->teacherProfile->is_public,
                    'completed' => $user->teacherProfile->completed_at !== null,
                ],
                'last_login_at' => $user->last_login_at?->toIso8601String(),
                'created_at' => $user->created_at?->toIso8601String(),
                'closed_at' => $user->deleted_at?->toIso8601String(),
            ])->values(),
            'meta' => [
                'current_page' => $users->currentPage(),
                'last_page' => $users->lastPage(),
                'per_page' => $users->perPage(),
                'total' => $users->total(),
            ],
        ]);
    }

    public function show(Request $request, User $user): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $user->load(['roles', 'studentProfile.educationLevel', 'teacherProfile']);

        // A closed account is soft deleted, so the reverse relation would skip
        // its own owner. The already-loaded row is bound explicitly instead.
        $student = $user->studentProfile;
        $student?->setRelation('user', $user);

        $teacher = $user->teacherProfile;
        $teacher?->setRelation('user', $user);

        return response()->json([
            'data' => (new UserResource($user))->resolve(),
            'student_profile' => $student === null ? null : (new StudentProfileResource($student))->resolve(),
            'teacher_profile' => $teacher === null ? null : (new TeacherResource($teacher->load([
                'subjects', 'educationLevels', 'streams', 'qualifications',
                'serviceLocations', 'availability', 'prices', 'reviews',
            ])))->resolve(),
        ]);
    }

    public function updateStatus(
        Request $request,
        User $user,
        AuditLogger $auditLogger,
        AccountSessionService $sessions,
    ): JsonResponse {
        $actor = $request->user();
        abort_unless($actor->isAdmin(), 403);

        $data = $request->validate([
            'status' => ['required', Rule::in(['active', 'suspended'])],
            'reason' => ['nullable', 'string', 'max:400'],
        ]);

        if ($actor->id === $user->id) {
            abort(422, 'You cannot change your own account status.');
        }

        if ($user->isAdmin() && ! $actor->isSuperAdmin()) {
            abort(403, 'Only a Super Admin can change an administrative account.');
        }

        $old = $user->status;
        $user->forceFill(['status' => $data['status']])->save();

        // A suspension must take effect immediately: the sessions and API
        // tokens that were issued while the account was active are revoked.
        if ($data['status'] === 'suspended') {
            $sessions->revoke($user);
        }

        $auditLogger->record(
            $actor,
            'user.status_changed',
            User::class,
            $user->id,
            ['status' => $old],
            ['status' => $data['status']],
            $data['reason'] ?? null,
        );

        return response()->json(['data' => ['id' => $user->id, 'status' => $user->status]]);
    }
}
