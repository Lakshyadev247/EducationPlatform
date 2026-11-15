<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\StudentProfileResource;
use App\Models\EducationLevel;
use App\Models\StudentAddress;
use App\Models\StudentProfile;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

class StudentProfileController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        $profile = $this->profileFor($request);

        return response()->json([
            'data' => (new StudentProfileResource($profile->load('user', 'educationLevel')))->resolve(),
        ]);
    }

    public function update(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $profile = $this->profileFor($request);
        $user = $request->user();

        $data = $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'email' => ['required', 'email', 'max:190', Rule::unique('users', 'email')->ignore($user->id)],
            'level' => ['required', 'string', Rule::exists('education_levels', 'key')->where('is_active', true)],
            'level_other' => ['nullable', 'string', 'max:80', 'required_if:level,other'],
            'intro' => ['nullable', 'string', 'max:300'],
            'completed' => ['sometimes', 'boolean'],
        ]);

        $level = EducationLevel::query()->where('key', $data['level'])->firstOrFail();

        DB::transaction(function () use ($data, $level, $profile, $user, $auditLogger): void {
            $old = [
                'name' => $user->name,
                'email' => $user->email,
                'level' => $profile->educationLevel?->key,
                'intro' => $profile->intro,
            ];

            $user->fill([
                'name' => trim($data['name']),
                'email' => strtolower(trim($data['email'])),
            ])->save();

            $profile->fill([
                'education_level_id' => $level->id,
                'level_other' => $data['level'] === 'other' ? $data['level_other'] : null,
                'intro' => $data['intro'] ?? null,
                'completed_at' => ($data['completed'] ?? false) ? ($profile->completed_at ?? now()) : $profile->completed_at,
            ])->save();

            $auditLogger->record(
                $user,
                'student.profile_updated',
                StudentProfile::class,
                $user->id,
                $old,
                [
                    'name' => $user->name,
                    'email' => $user->email,
                    'level' => $level->key,
                    'intro' => $profile->intro,
                ],
            );
        });

        return response()->json([
            'data' => (new StudentProfileResource($profile->fresh(['user', 'educationLevel'])))->resolve(),
        ]);
    }

    public function photo(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $request->validate([
            'photo' => ['required', 'image', 'mimes:jpg,jpeg,png,webp', 'max:5120'],
        ]);

        $profile = $this->profileFor($request);
        $oldPath = $profile->photo_path;
        $path = $request->file('photo')->store('profile-photos/'.$request->user()->id, 'public');

        $profile->forceFill(['photo_path' => $path])->save();

        if ($oldPath !== null && $oldPath !== $path) {
            Storage::disk('public')->delete($oldPath);
        }

        $auditLogger->record(
            $request->user(),
            'student.photo_updated',
            StudentProfile::class,
            $request->user()->id,
            ['photo_path' => $oldPath],
            ['photo_path' => $path],
        );

        return response()->json([
            'data' => ['photo_url' => Storage::disk('public')->url($path)],
        ]);
    }

    public function showAddress(Request $request): JsonResponse
    {
        $address = StudentAddress::query()->where('user_id', $request->user()->id)->first();

        if ($address === null) {
            return response()->json(['data' => null]);
        }

        return response()->json([
            'data' => [
                'address_line_1' => $address->address_line_1,
                'address_line_2' => $address->address_line_2,
                'area' => $address->area,
                'city' => $address->city,
                'state' => $address->state,
                'postal_code' => $address->postal_code,
                'country' => $address->country,
                'latitude' => $address->latitude,
                'longitude' => $address->longitude,
                'is_primary' => $address->is_primary,
            ],
        ]);
    }

    public function updateAddress(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'address_line_1' => ['nullable', 'string', 'max:200'],
            'address_line_2' => ['nullable', 'string', 'max:200'],
            'area' => ['nullable', 'string', 'max:120'],
            'city' => ['nullable', 'string', 'max:120'],
            'state' => ['nullable', 'string', 'max:120'],
            'postal_code' => ['nullable', 'string', 'max:20'],
            'country' => ['nullable', 'string', 'max:80'],
            'latitude' => ['nullable', 'numeric', 'between:-90,90'],
            'longitude' => ['nullable', 'numeric', 'between:-180,180'],
        ]);

        $address = StudentAddress::query()->updateOrCreate(
            ['user_id' => $request->user()->id],
            $data + ['is_primary' => true],
        );

        $auditLogger->record(
            $request->user(),
            'student.address_updated',
            StudentAddress::class,
            $request->user()->id,
            [],
            ['fields' => array_keys($data)],
            'Student updated their own private address.',
        );

        return response()->json(['message' => 'Address saved.', 'data' => ['updated_at' => $address->updated_at?->toIso8601String()]]);
    }

    private function profileFor(Request $request): StudentProfile
    {
        return StudentProfile::query()->firstOrCreate(
            ['user_id' => $request->user()->id],
            ['education_level_id' => null],
        );
    }
}
