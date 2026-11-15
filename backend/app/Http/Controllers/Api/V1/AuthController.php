<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\StudentProfileResource;
use App\Http\Resources\TeacherResource;
use App\Http\Resources\UserResource;
use App\Models\EducationLevel;
use App\Models\Role;
use App\Models\StudentProfile;
use App\Models\TeacherProfile;
use App\Models\TermsAcceptance;
use App\Models\TermsVersion;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Services\WhatsappOtpService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly AuditLogger $auditLogger,
        private readonly WhatsappOtpService $otp,
    ) {}

    public function sendRegistrationOtp(Request $request): JsonResponse
    {
        $otpSettings = $this->settings->get('otp', []);
        $requireOtp = (bool) ($otpSettings['enabled'] ?? true) && (bool) ($otpSettings['requireRegistrationOtp'] ?? false);
        if (! $requireOtp) {
            return response()->json(['message' => 'Registration OTP verification is not required.'], 400);
        }

        $data = $request->validate([
            'phone' => ['required', 'string', 'max:30', 'unique:users,phone'],
        ], [
            'phone.unique' => 'This phone number is already registered to an account.',
        ]);

        $result = $this->otp->issue(null, WhatsappOtpService::PURPOSE_REGISTRATION, $data['phone']);

        if (! $result['ok']) {
            return response()->json(['message' => $result['reason']], 422);
        }

        $payload = [
            'message' => 'A 6-digit verification code has been generated.',
            'delivered' => $result['delivered'],
            'expiresAt' => $result['expiresAt'],
        ];

        if (! app()->isProduction()) {
            $payload['code'] = $result['code'];
        }

        return response()->json(['data' => $payload], 200);
    }

    public function registerStudent(Request $request): JsonResponse
    {
        if (! (bool) ($this->settings->get('general.supportSignup', true))) {
            return response()->json(['message' => 'New signups are currently disabled.'], 403);
        }

        $otpSettings = $this->settings->get('otp', []);
        $requireOtp = (bool) ($otpSettings['enabled'] ?? true) && (bool) ($otpSettings['requireRegistrationOtp'] ?? false);

        $rules = [
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'email' => ['required', 'email', 'max:190', 'unique:users,email'],
            'phone' => ['required', 'string', 'max:30', 'unique:users,phone'],
            'password' => [
                'required', 'string',
                'min:'.(int) config('security.password.min_length', 12),
                'max:'.(int) config('security.password.max_length', 100),
                'confirmed',
            ],
            'level' => ['required', 'string', Rule::exists('education_levels', 'key')->where('is_active', true)],
            'level_other' => ['nullable', 'string', 'max:80', 'required_if:level,other'],
            'accept_terms' => ['accepted'],
        ];

        if ($requireOtp) {
            $rules['otp_code'] = ['required', 'string', 'digits:6'];
        }

        $data = $request->validate($rules);

        if ($requireOtp) {
            $verification = $this->otp->verify(null, WhatsappOtpService::PURPOSE_REGISTRATION, $data['otp_code'], $data['phone']);
            if (! $verification['ok']) {
                throw ValidationException::withMessages([
                    'otp_code' => [$verification['reason']],
                ]);
            }
        }

        // If terms are published, they will be recorded; if not yet published,
        // registration is permitted so users are not blocked.
        $terms = $this->applicableTermsVersion(Role::STUDENT);

        $user = DB::transaction(function () use ($data, $terms): User {
            $level = EducationLevel::query()->where('key', $data['level'])->firstOrFail();

            $user = User::query()->create([
                'name' => trim($data['name']),
                'email' => strtolower(trim($data['email'])),
                'phone' => $data['phone'] ?? null,
                'password' => $data['password'],
                'status' => 'active',
                'last_login_at' => now(),
            ]);

            $user->roles()->attach(
                Role::query()->where('name', Role::STUDENT)->firstOrFail()->id,
                ['assigned_at' => now()],
            );

            StudentProfile::query()->create([
                'user_id' => $user->id,
                'education_level_id' => $level->id,
                'level_other' => $data['level'] === 'other' ? $data['level_other'] : null,
            ]);

            if ($terms !== null) {
                $this->recordTermsAcceptance($user, Role::STUDENT, $terms);
            }

            return $user;
        });

        Auth::guard('web')->login($user);
        $request->session()->regenerate();

        return $this->sessionResponse($user->fresh(), 201);
    }

    public function registerTeacher(Request $request): JsonResponse
    {
        // Teacher registration has its own switch. It used to share
        // general.supportSignup with student registration, so the two could not
        // be controlled independently.
        if (! (bool) ($this->settings->get('general.teacherSignup', true))) {
            return response()->json(['message' => 'New teacher signups are currently disabled.'], 403);
        }

        $otpSettings = $this->settings->get('otp', []);
        $requireOtp = (bool) ($otpSettings['enabled'] ?? true) && (bool) ($otpSettings['requireRegistrationOtp'] ?? false);

        $rules = [
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'email' => ['required', 'email', 'max:190', 'unique:users,email'],
            'phone' => ['required', 'string', 'max:30', 'unique:users,phone'],
            'password' => [
                'required', 'string',
                'min:'.(int) config('security.password.min_length', 12),
                'max:'.(int) config('security.password.max_length', 100),
                'confirmed',
            ],
            'accept_terms' => ['accepted'],
        ];

        if ($requireOtp) {
            $rules['otp_code'] = ['required', 'string', 'digits:6'];
        }

        $data = $request->validate($rules);

        if ($requireOtp) {
            $verification = $this->otp->verify(null, WhatsappOtpService::PURPOSE_REGISTRATION, $data['otp_code'], $data['phone']);
            if (! $verification['ok']) {
                throw ValidationException::withMessages([
                    'otp_code' => [$verification['reason']],
                ]);
            }
        }

        $user = DB::transaction(function () use ($data): User {
            $user = User::query()->create([
                'name' => trim($data['name']),
                'email' => strtolower(trim($data['email'])),
                'phone' => $data['phone'] ?? null,
                'password' => $data['password'],
                'status' => 'active',
                'last_login_at' => now(),
            ]);

            $user->roles()->attach(
                Role::query()->where('name', Role::TEACHER)->firstOrFail()->id,
                ['assigned_at' => now()],
            );

            TeacherProfile::query()->create([
                'user_id' => $user->id,
                'approval_status' => 'pending',
                'is_public' => false,
            ]);

            $this->recordTermsAcceptance($user, Role::TEACHER);

            return $user;
        });

        Auth::guard('web')->login($user);
        $request->session()->regenerate();

        return $this->sessionResponse($user->fresh(), 201);
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);

        $credentials = [
            'email' => strtolower(trim($data['email'])),
            'password' => $data['password'],
            'status' => 'active',
        ];

        if (! Auth::guard('web')->attempt($credentials, false)) {
            $this->auditLogger->record(
                null,
                'auth.login_failed',
                User::class,
                null,
                [],
                ['email' => $this->maskEmail($credentials['email'])],
                'Invalid credentials or an inactive account.',
            );

            throw ValidationException::withMessages([
                'email' => ['These credentials do not match an active account.'],
            ]);
        }

        // A closed account keeps its historical rows but must never sign in.
        // The status already refuses it; the soft-delete check makes the rule
        // independent of that value.
        if (Auth::guard('web')->user()?->trashed()) {
            Auth::guard('web')->logout();

            $this->auditLogger->record(
                null,
                'auth.login_failed',
                User::class,
                null,
                [],
                ['email' => $this->maskEmail($credentials['email'])],
                'A closed account tried to sign in.',
            );

            throw ValidationException::withMessages([
                'email' => ['These credentials do not match an active account.'],
            ]);
        }

        $request->session()->regenerate();
        $user = $request->user();
        $user->forceFill(['last_login_at' => now()])->save();

        $this->auditLogger->record($user, 'auth.login', User::class, $user->id);

        return $this->sessionResponse($user->fresh());
    }

    public function logout(Request $request): JsonResponse
    {
        $user = $request->user();

        if ($user !== null) {
            $this->auditLogger->record($user, 'auth.logout', User::class, $user->id);
        }

        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['message' => 'Signed out.']);
    }

    public function me(Request $request): JsonResponse
    {
        return $this->sessionResponse($request->user());
    }

    /**
     * Keep a failed sign-in traceable without storing the full address.
     */
    private function maskEmail(string $email): string
    {
        [$local, $domain] = array_pad(explode('@', $email, 2), 2, '');

        if ($local === '' || $domain === '') {
            return '[redacted]';
        }

        return mb_substr($local, 0, 1).'***@'.$domain;
    }

    private function sessionResponse(User $user, int $status = 200): JsonResponse
    {
        $user->load('roles');

        if ($user->hasRole(Role::STUDENT)) {
            $user->load('studentProfile.educationLevel');
            $profile = $user->studentProfile === null
                ? null
                : new StudentProfileResource($user->studentProfile);
        } else {
            $user->load([
                'teacherProfile.subjects',
                'teacherProfile.educationLevels',
                'teacherProfile.streams',
                'teacherProfile.qualifications',
                'teacherProfile.serviceLocations',
                'teacherProfile.availability',
                'teacherProfile.prices',
                'teacherProfile.reviews',
            ]);
            $profile = $user->teacherProfile === null
                ? null
                : new TeacherResource($user->teacherProfile);
        }

        return response()->json([
            'data' => (new UserResource($user))->resolve(),
            'profile' => $profile,
        ], $status);
    }

    /**
     * The published document a member of the given role accepts: the version
     * published for that role, or the common version when the role has none
     * of its own. This is the same precedence the frontend uses when it shows
     * the document, so the recorded acceptance always points at the document
     * the member actually read and agreed to.
     */
    private function applicableTermsVersion(string $role): ?TermsVersion
    {
        $versions = TermsVersion::query()
            ->whereIn('audience', [$role, 'common'])
            ->where('is_current', true)
            ->latest('published_at')
            ->get()
            ->groupBy('audience');

        return ($versions->get($role) ?? $versions->get('common'))?->first();
    }

    /**
     * Records the acceptance of one published version. Nothing is written when
     * no document has been published, so consent is never invented. The
     * version that was required is passed in, so the acceptance always points
     * at the very document the registration was checked against.
     */
    private function recordTermsAcceptance(User $user, string $role, ?TermsVersion $version = null): bool
    {
        $version ??= $this->applicableTermsVersion($role);

        if ($version === null) {
            return false;
        }

        TermsAcceptance::query()->updateOrCreate(
            ['user_id' => $user->id, 'terms_version_id' => $version->id],
            ['role_at_acceptance' => $role, 'accepted_at' => now()],
        );

        return true;
    }
}
