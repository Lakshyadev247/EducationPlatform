<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\TeacherResource;
use App\Models\TeacherProfile;
use App\Models\TeacherSettingOverride;
use App\Models\TeacherUnavailableDate;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use App\Services\SettingsService;
use App\Services\Storage\StorageManagerService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class TeacherController extends Controller
{
    public function __construct(private readonly SettingsService $settings) {}

    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'status' => ['nullable', Rule::in(['pending', 'approved', 'rejected'])],
            'q' => ['nullable', 'string', 'max:100'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $query = TeacherProfile::query()
            ->with([
                'user', 'subjects', 'educationLevels', 'streams', 'qualifications',
                'serviceLocations', 'availability', 'prices',
                'idDocument', 'qualificationDocument',
            ])
            ->withCount(['reviews as review_count' => fn (Builder $q) => $q->where('status', 'published')])
            ->withAvg(['reviews as rating_average' => fn (Builder $q) => $q->where('status', 'published')], 'rating')
            ->orderByDesc('created_at');

        if (! empty($filters['status'])) {
            $query->where('approval_status', $filters['status']);
        }

        if (! empty($filters['q'])) {
            $term = '%'.trim($filters['q']).'%';
            $query->whereHas('user', fn (Builder $q) => $q->where('name', 'like', $term)->orWhere('email', 'like', $term));
        }

        $profiles = $query->paginate((int) ($filters['per_page'] ?? 25));

        return TeacherResource::collection($profiles)->response();
    }

    public function approve(Request $request, User $user, AuditLogger $auditLogger, NotificationService $notifications): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'approved' => ['required', 'boolean'],
            'reason' => ['nullable', 'string', 'max:400'],
        ]);

        $profile = TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();
        $old = $profile->approval_status;

        if ($data['approved']) {
            $profile->forceFill([
                'approval_status' => 'approved',
                'is_public' => true,
                'approved_at' => now(),
                'approved_by' => $request->user()->id,
            ])->save();
        } else {
            $profile->forceFill([
                'approval_status' => 'rejected',
                'is_public' => false,
                'approved_at' => null,
                'approved_by' => $request->user()->id,
            ])->save();
        }

        $auditLogger->record(
            $request->user(),
            'teacher.approval_changed',
            TeacherProfile::class,
            $user->id,
            ['approval_status' => $old, 'is_public' => ! $data['approved']],
            ['approval_status' => $profile->approval_status, 'is_public' => (bool) $profile->is_public],
            $data['reason'] ?? null,
        );

        $notifications->send(
            $user,
            'system',
            $data['approved'] ? 'Teacher profile approved' : 'Teacher profile approval changed',
            $data['approved']
                ? 'Your teacher profile is now visible in Find Teachers.'
                : 'Your teacher profile is no longer publicly listed. Contact support for details.',
            'teacher',
            $user->id,
            'teacher-approval:'.$user->id.':'.($data['approved'] ? 'approved' : 'rejected').':'.now()->timestamp,
        );

        return response()->json(['data' => [
            'id' => $user->id,
            'approval_status' => $profile->approval_status,
            'is_public' => (bool) $profile->is_public,
        ]]);
    }

    /**
     * The dates on which this teacher does not take lessons.
     *
     * A booking on one of these dates is refused by the booking endpoint, so
     * the dates are the teacher's own statement of when they are away. The
     * list is administrative information and is never published.
     */
    public function unavailableDates(Request $request, User $user): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $profile = TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();

        $dates = TeacherUnavailableDate::query()
            ->where('teacher_profile_id', $user->id)
            ->orderBy('unavailable_date')
            ->get()
            ->map(fn (TeacherUnavailableDate $date): array => [
                'date' => $date->unavailable_date?->toDateString(),
                'reason' => $date->reason,
            ])
            ->values();

        return response()->json(['data' => $dates]);
    }

    public function addUnavailableDate(Request $request, User $user, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'date' => ['required', 'date_format:Y-m-d'],
            'reason' => ['nullable', 'string', 'max:255'],
        ]);

        TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();

        $exists = TeacherUnavailableDate::query()
            ->where('teacher_profile_id', $user->id)
            ->whereDate('unavailable_date', $data['date'])
            ->exists();

        if ($exists) {
            throw ValidationException::withMessages([
                'date' => ['This teacher is already unavailable on that date.'],
            ]);
        }

        $date = TeacherUnavailableDate::query()->create([
            'teacher_profile_id' => $user->id,
            'unavailable_date' => $data['date'],
            'reason' => $data['reason'] ?? null,
        ]);

        $auditLogger->record(
            $request->user(),
            'teacher.unavailable_date_added',
            TeacherUnavailableDate::class,
            $date->id,
            [],
            ['teacher_id' => $user->id, 'date' => $data['date'], 'reason' => $data['reason'] ?? null],
            $data['reason'] ?? null,
        );

        return response()->json(['data' => [
            'date' => $date->unavailable_date?->toDateString(),
            'reason' => $date->reason,
        ]], 201);
    }

    /**
     * The settings one teacher has overridden.
     *
     * An override is a per-teacher exception to a platform default. The rules
     * are the ones the product already uses: a feature that is switched off
     * platform-wide can never be switched on again for a single teacher, and a
     * pricing type that is disabled platform-wide stays disabled.
     */
    public function overrides(Request $request, User $user): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();

        $overrides = TeacherSettingOverride::query()
            ->where('teacher_profile_id', $user->id)
            ->orderBy('group')
            ->orderBy('key')
            ->get()
            ->map(fn (TeacherSettingOverride $override): array => [
                'group' => $override->group,
                'key' => $override->key,
                'value' => $override->value,
            ])
            ->values();

        return response()->json([
            'data' => $overrides,
            'effective' => $this->settings->effectiveFor($user->id),
        ]);
    }

    public function setOverride(Request $request, User $user, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();

        $data = $request->validate([
            'group' => ['required', 'in:attendance,pricing,eligibility'],
            'key' => ['required', 'string', 'max:80'],
            'value' => ['present', 'nullable'],
        ]);

        $rules = $this->overrideRules($data['group'], $data['key']);

        if ($rules === []) {
            throw ValidationException::withMessages([
                'key' => ['This setting cannot be overridden for a teacher.'],
            ]);
        }

        if ($data['value'] !== null) {
            Validator::make(['value' => $data['value']], ['value' => $rules])->validate();
        }

        $old = TeacherSettingOverride::query()
            ->where('teacher_profile_id', $user->id)
            ->where('group', $data['group'])
            ->where('key', $data['key'])
            ->first();

        if ($data['value'] === null) {
            // An empty value removes the override, so the platform default
            // applies again.
            $old?->delete();

            $auditLogger->record(
                $request->user(),
                'teacher.setting_override_removed',
                TeacherSettingOverride::class,
                $old?->id,
                ['group' => $data['group'], 'key' => $data['key'], 'value' => $old?->value],
                [],
            );

            return response()->json(['message' => 'The override was removed.']);
        }

        $override = TeacherSettingOverride::query()->updateOrCreate(
            [
                'teacher_profile_id' => $user->id,
                'group' => $data['group'],
                'key' => $data['key'],
            ],
            [
                'value' => $data['value'],
                'updated_by' => $request->user()->id,
            ],
        );

        $auditLogger->record(
            $request->user(),
            'teacher.setting_override_updated',
            TeacherSettingOverride::class,
            $override->id,
            ['group' => $data['group'], 'key' => $data['key'], 'value' => $old?->value],
            ['group' => $data['group'], 'key' => $data['key'], 'value' => $data['value']],
        );

        return response()->json(['data' => [
            'group' => $override->group,
            'key' => $override->key,
            'value' => $override->value,
        ]], 201);
    }

    /**
     * The rules an overridden value has to follow.
     *
     * @return list<string>
     */
    private function overrideRules(string $group, string $key): array
    {
        return match ($group) {
            'attendance' => match ($key) {
                'verificationEnabled' => ['boolean'],
                'verificationMethod' => ['in:teacher-and-student,teacher-only'],
                'requireReasonWhenLessonMissed' => ['boolean'],
                default => [],
            },
            'pricing' => match ($key) {
                'hourly', 'monthly', 'course' => ['array', 'enabled' => ['sometimes', 'boolean'], 'mode' => ['sometimes', 'in:optional,required']],
                default => [],
            },
            'eligibility' => match ($key) {
                'configured' => ['boolean'],
                'type' => ['in:study-days,completed-lessons'],
                'minConfirmedDays' => ['integer', 'min:0', 'max:99'],
                'minCompletedLessons' => ['integer', 'min:0', 'max:99'],
                'requireCompletedBooking' => ['boolean'],
                default => [],
            },
            default => [],
        };
    }

    public function removeUnavailableDate(Request $request, User $user, string $date, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        Validator::make(['date' => $date], ['date' => ['required', 'date_format:Y-m-d']])->validate();

        $row = TeacherUnavailableDate::query()
            ->where('teacher_profile_id', $user->id)
            ->whereDate('unavailable_date', $date)
            ->first();

        if ($row === null) {
            abort(404, 'This teacher is not unavailable on that date.');
        }

        $row->delete();

        $auditLogger->record(
            $request->user(),
            'teacher.unavailable_date_removed',
            TeacherUnavailableDate::class,
            $row->id,
            ['teacher_id' => $user->id, 'date' => $date],
            [],
            $row->reason,
        );

        return response()->json(['message' => 'The unavailable date was removed.']);
    }

    public function documents(Request $request, User $user, StorageManagerService $storage): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $profile = TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();
        $idDoc = $profile->idDocument;
        $qualDoc = $profile->qualificationDocument;

        return response()->json([
            'data' => [
                'teacher' => [
                    'id' => $user->id,
                    'name' => $user->name,
                    'email' => $user->email,
                ],
                'status' => $profile->document_verification_status ?? 'not_uploaded',
                'verified_at' => $profile->document_verified_at?->toIso8601String(),
                'verified_by' => $profile->documentVerifiedBy?->name,
                'rejection_reason' => $profile->document_rejection_reason,
                'id_document' => $idDoc ? [
                    'id' => $idDoc->id,
                    'name' => $idDoc->original_name,
                    'size' => $idDoc->formatted_size,
                    'mime' => $idDoc->mime_type,
                    'url' => $storage->getTemporaryUrl($idDoc, 30),
                    'created_at' => $idDoc->created_at?->toIso8601String(),
                ] : null,
                'qualification_document' => $qualDoc ? [
                    'id' => $qualDoc->id,
                    'name' => $qualDoc->original_name,
                    'size' => $qualDoc->formatted_size,
                    'mime' => $qualDoc->mime_type,
                    'url' => $storage->getTemporaryUrl($qualDoc, 30),
                    'created_at' => $qualDoc->created_at?->toIso8601String(),
                ] : null,
            ],
        ]);
    }

    public function verifyDocuments(
        Request $request,
        User $user,
        AuditLogger $auditLogger,
        NotificationService $notifications,
        StorageManagerService $storage
    ): JsonResponse {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'action' => ['required', Rule::in(['approve', 'reject'])],
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $profile = TeacherProfile::query()->where('user_id', $user->id)->firstOrFail();
        $oldStatus = $profile->document_verification_status;

        if ($data['action'] === 'approve') {
            if (!$profile->id_document_id && !$profile->qualification_document_id) {
                abort(422, 'Cannot approve documents because no documents have been uploaded by this teacher.');
            }

            $profile->forceFill([
                'document_verification_status' => 'verified',
                'document_verified_at' => now(),
                'document_verified_by' => $request->user()->id,
                'document_rejection_reason' => null,
            ])->save();

            $notifications->send(
                $user,
                'system',
                'Teacher Documents Verified',
                'Your identity and qualification documents have been reviewed and approved by an administrator.'
            );
        } else {
            $reason = trim($data['reason'] ?? '') ?: 'Uploaded documents did not meet verification criteria.';

            $profile->forceFill([
                'document_verification_status' => 'rejected',
                'document_verified_at' => null,
                'document_verified_by' => $request->user()->id,
                'document_rejection_reason' => $reason,
            ])->save();

            $notifications->send(
                $user,
                'system',
                'Teacher Document Verification Needs Attention',
                "Your document verification was rejected: {$reason}. Please re-upload valid documents."
            );
        }

        $auditLogger->record(
            $request->user(),
            'teacher.document_verification_changed',
            TeacherProfile::class,
            $user->id,
            ['status' => $oldStatus],
            ['status' => $profile->document_verification_status, 'reason' => $profile->document_rejection_reason],
            $data['action'] === 'approve' ? 'Approved teacher documents' : "Rejected teacher documents: {$profile->document_rejection_reason}"
        );

        return $this->documents($request, $user, $storage);
    }
}
