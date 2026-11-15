<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\TeacherResource;
use App\Models\EducationLevel;
use App\Models\Stream;
use App\Models\Subject;
use App\Models\TeacherAvailability;
use App\Models\TeacherProfile;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Services\Storage\StorageManagerService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class TeacherProfileController extends Controller
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    public function show(Request $request): JsonResponse
    {
        $profile = $this->profileFor($request);
        $this->loadProfile($profile);

        return response()->json(['data' => (new TeacherResource($profile))->resolve()]);
    }

    public function update(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:2', 'max:120'],
            'email' => ['sometimes', 'email', 'max:190', Rule::unique('users', 'email')->ignore($request->user()->id)],
            'bio' => ['sometimes', 'nullable', 'string', 'max:300'],
            'experience_level' => ['sometimes', 'nullable', 'string', 'max:40'],
            'level_other' => ['sometimes', 'nullable', 'string', 'max:80'],
            'experience_years' => ['sometimes', 'nullable', 'numeric', 'between:0,60'],
            'experience_org' => ['sometimes', 'nullable', 'string', 'max:160'],
            'experience_description' => ['sometimes', 'nullable', 'string', 'max:240'],
            'teaching_mode' => ['sometimes', 'nullable', Rule::in(['online', 'in-person', 'both'])],
            'online_tools' => ['sometimes', 'nullable', 'string', 'max:160'],
            'timezone' => ['sometimes', 'string', 'max:64'],
            'subjects' => ['sometimes', 'array', 'max:20'],
            'subjects.*' => ['required', 'string', 'max:100'],
            'grades' => ['sometimes', 'array', 'max:5'],
            'grades.*' => ['required', 'string', Rule::exists('education_levels', 'key')->where('is_active', true)],
            'streams' => ['sometimes', 'array', 'max:3'],
            'streams.*' => ['required', 'string', Rule::exists('streams', 'key')->where('is_active', true)],
            'qualifications' => ['sometimes', 'array', 'max:10'],
            'qualifications.*.name' => ['required', 'string', 'max:160'],
            'qualifications.*.institution' => ['nullable', 'string', 'max:160'],
            'qualifications.*.year' => ['nullable', 'integer', 'between:1900,2100'],
            'location' => ['sometimes', 'array'],
            'location.area' => ['nullable', 'string', 'max:120'],
            'location.city' => ['required_with:location', 'string', 'max:120'],
            'location.state' => ['required_with:location', 'string', 'max:120'],
            'location.country' => ['required_with:location', 'string', 'max:80'],
            'location.radius_km' => ['nullable', 'integer', 'between:0,500'],
            'location.radius' => ['nullable', 'string', 'max:40'],
            // A teacher may publish an empty schedule: that is how a teacher
            // takes a break without giving up the profile. The server refuses
            // new lesson requests for a teacher with no published hours, and
            // the teacher keeps the bookings, the attendance and the reviews
            // that are already on record.
            'availability' => ['sometimes', 'array', 'max:50'],
            'availability.*.day' => ['required_without:availability.*.day_of_week', 'string', Rule::in(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])],
            'availability.*.day_of_week' => ['required_without:availability.*.day', 'integer', 'between:0,6'],
            'availability.*.start_time' => ['required', 'date_format:H:i'],
            'availability.*.end_time' => ['required', 'date_format:H:i', 'after:availability.*.start_time'],
            'availability.*.start' => ['sometimes', 'date_format:H:i'],
            'availability.*.end' => ['sometimes', 'date_format:H:i'],
            'completed' => ['sometimes', 'boolean'],
        ]);

        $profile = $this->profileFor($request);
        $user = $request->user();

        DB::transaction(function () use ($data, $profile, $user, $auditLogger): void {
            $old = $profile->only([
                'bio', 'experience_level', 'experience_years', 'experience_org',
                'experience_description', 'teaching_mode', 'online_tools', 'is_public', 'approval_status',
            ]);

            if (array_key_exists('name', $data)) {
                $user->name = trim($data['name']);
            }
            if (array_key_exists('email', $data)) {
                $user->email = strtolower(trim($data['email']));
            }
            if ($user->isDirty()) {
                $user->save();
            }

            $profileData = [];
            foreach ([
                'bio', 'experience_level', 'level_other', 'experience_years',
                'experience_org', 'experience_description', 'teaching_mode', 'online_tools', 'timezone',
            ] as $field) {
                if (array_key_exists($field, $data)) {
                    $profileData[$field] = $data[$field];
                }
            }

            if (($data['completed'] ?? false) === true) {
                $profileData['completed_at'] = $profile->completed_at ?? now();

                if ((bool) ($this->settings->get('general.teacherApprovalRequired', false))) {
                    if (! $profile->is_public) {
                        $profileData['approval_status'] = 'pending';
                        $profileData['is_public'] = false;
                    }
                } else {
                    $profileData['approval_status'] = 'approved';
                    $profileData['approved_at'] = $profile->approved_at ?? now();
                    $profileData['is_public'] = true;
                }
            }

            if ($profileData !== []) {
                $profile->fill($profileData)->save();
            }

            if (array_key_exists('subjects', $data)) {
                $subjectIds = [];
                foreach ($data['subjects'] as $name) {
                    $subjectIds[] = $this->resolveSubject(trim($name))->id;
                }
                $profile->subjects()->sync(array_values(array_unique($subjectIds)));
            }

            if (array_key_exists('grades', $data)) {
                $levelIds = EducationLevel::query()->whereIn('key', $data['grades'])->pluck('id')->all();
                $profile->educationLevels()->sync($levelIds);
            }

            if (array_key_exists('streams', $data)) {
                $streamIds = Stream::query()->whereIn('key', $data['streams'])->pluck('id')->all();
                $profile->streams()->sync($streamIds);
            }

            if (array_key_exists('qualifications', $data)) {
                $profile->qualifications()->delete();
                foreach ($data['qualifications'] as $qualification) {
                    $profile->qualifications()->create([
                        'name' => trim($qualification['name']),
                        'institution' => $qualification['institution'] ?? null,
                        'year_completed' => $qualification['year'] ?? null,
                    ]);
                }
            }

            if (array_key_exists('location', $data)) {
                $location = $data['location'];
                $profile->serviceLocations()->delete();
                $profile->serviceLocations()->create([
                    'area' => $location['area'] ?? null,
                    'city' => $location['city'],
                    'state' => $location['state'],
                    'country' => $location['country'],
                    'teaching_radius_km' => $this->radiusFrom($location),
                    'is_primary' => true,
                ]);
            }

            if (array_key_exists('availability', $data)) {
                $this->replaceAvailability($profile, $data['availability']);
            }

            $auditLogger->record(
                $user,
                'teacher.profile_updated',
                TeacherProfile::class,
                $user->id,
                $old,
                $profile->fresh()->only([
                    'bio', 'experience_level', 'experience_years', 'experience_org',
                    'experience_description', 'teaching_mode', 'online_tools', 'is_public', 'approval_status',
                ]),
            );
        });

        $profile = $this->profileFor($request);
        $this->loadProfile($profile);

        return response()->json(['data' => (new TeacherResource($profile))->resolve()]);
    }

    public function photo(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $request->validate([
            'photo' => ['required', 'image', 'mimes:jpg,jpeg,png,webp', 'max:5120'],
        ]);

        $profile = $this->profileFor($request);
        $oldPath = $profile->photo_path;
        $path = $request->file('photo')->store('teacher-photos/'.$request->user()->id, 'public');

        $profile->forceFill(['photo_path' => $path])->save();

        if ($oldPath !== null && $oldPath !== $path) {
            Storage::disk('public')->delete($oldPath);
        }

        $auditLogger->record(
            $request->user(),
            'teacher.photo_updated',
            TeacherProfile::class,
            $request->user()->id,
            ['photo_path' => $oldPath],
            ['photo_path' => $path],
        );

        return response()->json(['data' => ['photo_url' => Storage::disk('public')->url($path)]]);
    }

    public function updatePrices(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'prices' => ['required', 'array'],
            'prices.hourly' => ['sometimes', 'nullable', 'numeric', 'min:0.01', 'max:999999.99'],
            'prices.monthly' => ['sometimes', 'nullable', 'numeric', 'min:0.01', 'max:999999.99'],
            'prices.course' => ['sometimes', 'nullable', 'numeric', 'min:0.01', 'max:999999.99'],
        ]);

        $profile = $this->profileFor($request);
        $enabled = $this->settings->effectiveFor($profile->user_id)['pricing'] ?? [];

        DB::transaction(function () use ($data, $enabled, $profile, $request, $auditLogger): void {
            foreach (['hourly', 'monthly', 'course'] as $type) {
                $amount = $data['prices'][$type] ?? null;
                $allowed = (bool) ($enabled[$type]['enabled'] ?? $type === 'hourly');

                if ($amount === null || ! $allowed) {
                    $profile->prices()->where('pricing_type', $type)->delete();

                    continue;
                }

                $profile->prices()->updateOrCreate(
                    ['pricing_type' => $type],
                    ['amount' => $amount, 'currency' => 'INR'],
                );
            }

            // A pricing type the platform requires cannot be left empty. The
            // requirement is enforced here, so it cannot be skipped by a
            // request that does not come from the pricing form.
            foreach (['hourly', 'monthly', 'course'] as $type) {
                if (($enabled[$type]['mode'] ?? 'optional') !== 'required') {
                    continue;
                }

                if (! (bool) ($enabled[$type]['enabled'] ?? $type === 'hourly')) {
                    continue;
                }

                if ($profile->prices()->where('pricing_type', $type)->exists()) {
                    continue;
                }

                throw ValidationException::withMessages([
                    'prices.'.$type => ['This pricing type is required, so the teacher has to offer it.'],
                ]);
            }

            $auditLogger->record(
                $request->user(),
                'teacher.prices_updated',
                TeacherProfile::class,
                $profile->user_id,
                [],
                ['prices' => $data['prices']],
            );
        });

        $profile->load('prices');

        return response()->json(['data' => ['prices' => $profile->prices->mapWithKeys(fn ($p): array => [
            $p->pricing_type => ['amount' => (float) $p->amount, 'currency' => $p->currency],
        ])]]);
    }

    private function profileFor(Request $request): TeacherProfile
    {
        return TeacherProfile::query()->firstOrCreate(
            ['user_id' => $request->user()->id],
            ['approval_status' => 'pending', 'is_public' => false],
        );
    }

    private function loadProfile(TeacherProfile $profile): void
    {
        $profile->load([
            'user',
            'subjects',
            'educationLevels',
            'streams',
            'qualifications',
            'serviceLocations',
            'availability',
            'prices',
            'reviews',
            'idDocument',
            'qualificationDocument',
        ]);
    }

    private function resolveSubject(string $name): Subject
    {
        $existing = Subject::query()->where('name', $name)->first();
        if ($existing !== null) {
            return $existing;
        }

        $base = Str::slug($name) ?: 'subject';
        $slug = $base;
        $suffix = 2;
        while (Subject::query()->where('slug', $slug)->exists()) {
            $slug = $base.'-'.$suffix;
            $suffix++;
        }

        return Subject::query()->create([
            'name' => $name,
            'slug' => $slug,
            'sort_order' => 500,
            'is_active' => true,
        ]);
    }

    private function radiusFrom(array $location): ?int
    {
        if (isset($location['radius_km'])) {
            return (int) $location['radius_km'] === 0 ? null : (int) $location['radius_km'];
        }

        $value = (string) ($location['radius'] ?? '');
        if ($value === '' || stripos($value, 'no limit') !== false) {
            return null;
        }

        return preg_match('/(\d+)/', $value, $matches) === 1 ? (int) $matches[1] : null;
    }

    /**
     * @param  array<int, array<string, mixed>>  $slots
     */
    private function replaceAvailability(TeacherProfile $profile, array $slots): void
    {
        $dayMap = ['sun' => 0, 'mon' => 1, 'tue' => 2, 'wed' => 3, 'thu' => 4, 'fri' => 5, 'sat' => 6];
        $normalized = [];

        foreach ($slots as $slot) {
            $day = isset($slot['day_of_week'])
                ? (int) $slot['day_of_week']
                : ($dayMap[$slot['day']] ?? null);

            $start = $slot['start_time'] ?? $slot['start'] ?? null;
            $end = $slot['end_time'] ?? $slot['end'] ?? null;

            if ($day === null || $start === null || $end === null || $start >= $end) {
                throw ValidationException::withMessages([
                    'availability' => ['Each availability slot needs a valid day and an end time after its start time.'],
                ]);
            }

            $normalized[] = [
                'day_of_week' => $day,
                'start_time' => $start,
                'end_time' => $end,
            ];
        }

        foreach ($normalized as $index => $slot) {
            foreach ($normalized as $otherIndex => $other) {
                if ($index >= $otherIndex || $slot['day_of_week'] !== $other['day_of_week']) {
                    continue;
                }

                if ($slot['start_time'] < $other['end_time'] && $other['start_time'] < $slot['end_time']) {
                    throw ValidationException::withMessages([
                        'availability' => ['Availability slots on the same day cannot overlap.'],
                    ]);
                }
            }
        }

        $profile->availability()->delete();

        foreach ($normalized as $slot) {
            TeacherAvailability::query()->create([
                'teacher_profile_id' => $profile->user_id,
                'day_of_week' => $slot['day_of_week'],
                'start_time' => $slot['start_time'],
                'end_time' => $slot['end_time'],
            ]);
        }
    }

    public function documents(Request $request, StorageManagerService $storage): JsonResponse
    {
        $profile = $this->profileFor($request);
        $idDoc = $profile->idDocument;
        $qualDoc = $profile->qualificationDocument;
        $required = (bool) $this->settings->get('general.requireTeacherDocumentVerification', true);

        return response()->json([
            'data' => [
                'status' => $profile->document_verification_status ?? 'not_uploaded',
                'verified_at' => $profile->document_verified_at?->toIso8601String(),
                'rejection_reason' => $profile->document_rejection_reason,
                'required' => $required,
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

    public function uploadDocuments(Request $request, StorageManagerService $storage, AuditLogger $auditLogger): JsonResponse
    {
        if (! (bool) $this->settings->get('general.requireTeacherDocumentVerification', true)) {
            abort(403, 'Teacher document verification is currently disabled by administrator.');
        }

        $request->validate([
            'id_document' => ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png,webp', 'max:10240'],
            'qualification_document' => ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png,webp', 'max:10240'],
        ]);

        $profile = $this->profileFor($request);
        $user = $request->user();

        if (!$request->hasFile('id_document') && !$request->hasFile('qualification_document')) {
            throw ValidationException::withMessages([
                'id_document' => ['Please select at least one document to upload (Government ID or Qualification Certificate).'],
            ]);
        }

        if ($request->hasFile('id_document')) {
            $idDoc = $storage->upload(
                $request->file('id_document'),
                'teacher_ids',
                $user,
                ['purpose' => 'teacher_id_verification', 'user_id' => $user->id],
                $user
            );
            $profile->id_document_id = $idDoc->id;
        }

        if ($request->hasFile('qualification_document')) {
            $qualDoc = $storage->upload(
                $request->file('qualification_document'),
                'teacher_qualifications',
                $user,
                ['purpose' => 'teacher_qualification_verification', 'user_id' => $user->id],
                $user
            );
            $profile->qualification_document_id = $qualDoc->id;
        }

        $profile->document_verification_status = 'pending';
        $profile->document_verified_at = null;
        $profile->document_rejection_reason = null;
        $profile->save();

        $auditLogger->record(
            $user,
            'teacher.documents_uploaded',
            TeacherProfile::class,
            $user->id,
            [],
            [
                'id_document_id' => $profile->id_document_id,
                'qualification_document_id' => $profile->qualification_document_id,
                'status' => 'pending',
            ],
            'Teacher submitted verification documents'
        );

        return $this->documents($request, $storage);
    }
}
