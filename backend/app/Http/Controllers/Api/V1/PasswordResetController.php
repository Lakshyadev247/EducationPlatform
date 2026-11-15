<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\AccountSessionService;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Services\WhatsappOtpService;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Token based password recovery.
 *
 * The token is the standard Laravel broker token: it is stored hashed in
 * password_reset_tokens, expires (auth.passwords.users.expire, 60 minutes by
 * default) and is removed after a successful reset, so it can only be used
 * once. The response never says whether an address exists: the request
 * endpoint answers the same way for an unknown, closed or suspended account.
 *
 * Delivery uses the configured mail transport. It is only a real delivery when
 * the deployment has configured a mail provider; the application does not
 * pretend otherwise, and the tests use the array transport.
 */
class PasswordResetController extends Controller
{
    public function request(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'email', 'max:190'],
        ]);

        $email = Str::lower(trim($data['email']));

        $user = User::query()->where('email', $email)->first();

        if ($user !== null && $user->status === 'active' && ! $user->trashed()) {
            $token = Password::broker()->createToken($user);

            try {
                $user->notify(new ResetPassword($token));
            } catch (Throwable $exception) {
                // A mail transport problem must not turn into an account
                // enumeration oracle, and it must not lose the audit trail.
                report($exception);
            }

            $auditLogger->record(
                null,
                'auth.password_reset_requested',
                User::class,
                $user->id,
            );
        }

        return response()->json([
            'message' => 'If that address belongs to an active account, a reset link is on its way.',
        ], 202);
    }

    public function reset(Request $request, AccountSessionService $sessions, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'token' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:190'],
            'password' => [
                'required',
                'string',
                'min:'.(int) config('security.password.min_length', 12),
                'max:'.(int) config('security.password.max_length', 100),
                'confirmed',
            ],
        ]);

        $data['email'] = Str::lower(trim($data['email']));

        $status = Password::broker()->reset(
            $data,
            function (User $user, string $password) use ($sessions, $auditLogger): void {
                $user->forceFill([
                    'password' => Hash::make($password),
                    'remember_token' => Str::random(60),
                ])->save();

                // A reset is also a sign-out everywhere: any session opened with
                // the old password may belong to somebody else.
                $sessions->revoke($user);

                $auditLogger->record(
                    null,
                    'auth.password_reset',
                    User::class,
                    $user->id,
                );
            }
        );

        if ($status !== Password::PASSWORD_RESET) {
            throw ValidationException::withMessages([
                'email' => ['This password reset link is invalid or has expired.'],
            ]);
        }

        return response()->json([
            'message' => 'Your password has been reset. You can sign in now.',
        ]);
    }

    public function otpRequest(
        Request $request,
        SettingsService $settings,
        WhatsappOtpService $otp,
        AuditLogger $auditLogger,
    ): JsonResponse {
        $otpSettings = $settings->get('otp', []);
        if (! (bool) ($otpSettings['enabled'] ?? true)) {
            return response()->json(['message' => 'Password reset via phone OTP is currently disabled.'], 403);
        }

        $data = $request->validate([
            'phone' => ['nullable', 'string', 'max:30'],
            'country_code' => ['nullable', 'string', 'max:10'],
            'identifier' => ['nullable', 'string', 'max:190'],
        ]);

        $rawPhone = trim($data['phone'] ?? $data['identifier'] ?? '');
        $countryCode = trim($data['country_code'] ?? '');
        if ($rawPhone === '') {
            throw ValidationException::withMessages([
                'phone' => ['Please enter your registered phone number.'],
            ]);
        }

        if ($countryCode !== '' && ! str_starts_with($rawPhone, '+')) {
            $rawPhone = $countryCode . ltrim($rawPhone, '0');
        }

        $normalised = $otp->normaliseRecipient($rawPhone);
        $cleanDigits = preg_replace('/[^0-9]/', '', $rawPhone) ?? '';

        $user = User::query()
            ->where(function ($q) use ($rawPhone, $normalised, $cleanDigits) {
                $q->where('phone', $rawPhone);
                if ($normalised) {
                    $q->orWhere('phone', $normalised);
                }
                if ($cleanDigits !== '') {
                    $q->orWhere('phone', $cleanDigits);
                    if (strlen($cleanDigits) >= 10) {
                        $last10 = substr($cleanDigits, -10);
                        $q->orWhere('phone', 'like', "%{$last10}");
                    }
                }
                $q->orWhere('email', Str::lower($rawPhone));
            })
            ->where('status', 'active')
            ->first();

        if ($user !== null && ! empty($user->phone) && ! $user->trashed()) {
            $recipient = $otp->normaliseRecipient($user->phone) ?? $user->phone;
            $result = $otp->issue($user, WhatsappOtpService::PURPOSE_PASSWORD_RESET, $recipient);

            if (! $result['ok']) {
                return response()->json(['message' => $result['reason'] ?? 'Failed to send OTP.'], 422);
            }

            $auditLogger->record(
                null,
                'auth.password_reset_otp_requested',
                User::class,
                $user->id,
            );

            $payload = [
                'delivered' => $result['delivered'],
                'expiresAt' => $result['expiresAt'],
                'recipient' => preg_replace('/\d(?=\d{2})/', '*', $recipient),
            ];

            if (! app()->isProduction()) {
                $payload['code'] = $result['code'];
            }

            return response()->json([
                'message' => 'If that account exists with a registered phone number, a 6-digit OTP has been sent.',
                'data' => $payload,
            ], 200);
        }

        return response()->json([
            'message' => 'If that account exists with a registered phone number, a 6-digit OTP has been sent.',
        ], 200);
    }

    public function otpVerify(
        Request $request,
        SettingsService $settings,
        WhatsappOtpService $otp,
        AuditLogger $auditLogger,
    ): JsonResponse {
        $otpSettings = $settings->get('otp', []);
        if (! (bool) ($otpSettings['enabled'] ?? true)) {
            return response()->json(['message' => 'Password reset via phone OTP is currently disabled.'], 403);
        }

        $data = $request->validate([
            'phone' => ['nullable', 'string', 'max:30'],
            'country_code' => ['nullable', 'string', 'max:10'],
            'identifier' => ['nullable', 'string', 'max:190'],
            'otp_code' => ['required', 'string', 'digits:6'],
        ], [
            'otp_code.digits' => 'The OTP code must be exactly 6 digits.',
        ]);

        $rawPhone = trim($data['phone'] ?? $data['identifier'] ?? '');
        $countryCode = trim($data['country_code'] ?? '');
        if ($rawPhone === '') {
            throw ValidationException::withMessages([
                'phone' => ['Please enter your registered phone number.'],
            ]);
        }

        if ($countryCode !== '' && ! str_starts_with($rawPhone, '+')) {
            $rawPhone = $countryCode . ltrim($rawPhone, '0');
        }

        $normalised = $otp->normaliseRecipient($rawPhone);
        $cleanDigits = preg_replace('/[^0-9]/', '', $rawPhone) ?? '';

        $user = User::query()
            ->where(function ($q) use ($rawPhone, $normalised, $cleanDigits) {
                $q->where('phone', $rawPhone);
                if ($normalised) {
                    $q->orWhere('phone', $normalised);
                }
                if ($cleanDigits !== '') {
                    $q->orWhere('phone', $cleanDigits);
                    if (strlen($cleanDigits) >= 10) {
                        $last10 = substr($cleanDigits, -10);
                        $q->orWhere('phone', 'like', "%{$last10}");
                    }
                }
                $q->orWhere('email', Str::lower($rawPhone));
            })
            ->where('status', 'active')
            ->first();

        if ($user === null || empty($user->phone) || $user->trashed()) {
            throw ValidationException::withMessages([
                'phone' => ['No active account with this phone number was found.'],
                'otp_code' => ['Invalid code or unregistered account.'],
            ]);
        }

        $recipient = $otp->normaliseRecipient($user->phone) ?? $user->phone;

        $verification = $otp->verify($user, WhatsappOtpService::PURPOSE_PASSWORD_RESET, $data['otp_code'], $recipient);
        if (! $verification['ok']) {
            $verification2 = $otp->verify($user, WhatsappOtpService::PURPOSE_PASSWORD_RESET, $data['otp_code'], null);
            if ($verification2['ok']) {
                $verification = $verification2;
            }
        }

        if (! $verification['ok']) {
            throw ValidationException::withMessages([
                'otp_code' => [$verification['reason']],
            ]);
        }

        $resetToken = Password::broker()->createToken($user);

        $auditLogger->record(
            $user,
            'auth.password_reset_otp_verified',
            User::class,
            $user->id,
        );

        return response()->json([
            'message' => 'OTP verified successfully. You can now set your new password.',
            'reset_token' => $resetToken,
        ]);
    }

    public function otpReset(
        Request $request,
        SettingsService $settings,
        WhatsappOtpService $otp,
        AccountSessionService $sessions,
        AuditLogger $auditLogger,
    ): JsonResponse {
        $otpSettings = $settings->get('otp', []);
        if (! (bool) ($otpSettings['enabled'] ?? true)) {
            return response()->json(['message' => 'Password reset via phone OTP is currently disabled.'], 403);
        }

        $data = $request->validate([
            'phone' => ['nullable', 'string', 'max:30'],
            'country_code' => ['nullable', 'string', 'max:10'],
            'identifier' => ['nullable', 'string', 'max:190'],
            'reset_token' => ['nullable', 'string', 'max:255'],
            'otp_code' => ['nullable', 'string', 'digits:6'],
            'password' => [
                'required',
                'string',
                'min:'.(int) config('security.password.min_length', 12),
                'max:'.(int) config('security.password.max_length', 100),
                'confirmed',
            ],
        ], [
            'otp_code.digits' => 'The OTP code must be exactly 6 digits.',
            'password.confirmed' => 'The password confirmation does not match.',
            'password.min' => 'The password must be at least '.(int) config('security.password.min_length', 12).' characters.',
        ]);

        $rawPhone = trim($data['phone'] ?? $data['identifier'] ?? '');
        $countryCode = trim($data['country_code'] ?? '');
        if ($rawPhone === '') {
            throw ValidationException::withMessages([
                'phone' => ['Please enter your registered phone number.'],
            ]);
        }

        if ($countryCode !== '' && ! str_starts_with($rawPhone, '+')) {
            $rawPhone = $countryCode . ltrim($rawPhone, '0');
        }

        $normalised = $otp->normaliseRecipient($rawPhone);
        $cleanDigits = preg_replace('/[^0-9]/', '', $rawPhone) ?? '';

        $user = User::query()
            ->where(function ($q) use ($rawPhone, $normalised, $cleanDigits) {
                $q->where('phone', $rawPhone);
                if ($normalised) {
                    $q->orWhere('phone', $normalised);
                }
                if ($cleanDigits !== '') {
                    $q->orWhere('phone', $cleanDigits);
                    if (strlen($cleanDigits) >= 10) {
                        $last10 = substr($cleanDigits, -10);
                        $q->orWhere('phone', 'like', "%{$last10}");
                    }
                }
                $q->orWhere('email', Str::lower($rawPhone));
            })
            ->where('status', 'active')
            ->first();

        if ($user === null || empty($user->phone) || $user->trashed()) {
            throw ValidationException::withMessages([
                'phone' => ['No active account with this phone number was found.'],
                'identifier' => ['No active account with this phone number was found.'],
            ]);
        }

        if (! empty($data['reset_token'])) {
            if (! Password::broker()->tokenExists($user, $data['reset_token'])) {
                throw ValidationException::withMessages([
                    'reset_token' => ['Invalid or expired verification session. Please verify OTP again.'],
                ]);
            }
            Password::broker()->deleteToken($user);
        } elseif (! empty($data['otp_code'])) {
            $recipient = $otp->normaliseRecipient($user->phone) ?? $user->phone;

            $verification = $otp->verify($user, WhatsappOtpService::PURPOSE_PASSWORD_RESET, $data['otp_code'], $recipient);
            if (! $verification['ok']) {
                $verification2 = $otp->verify($user, WhatsappOtpService::PURPOSE_PASSWORD_RESET, $data['otp_code'], null);
                if ($verification2['ok']) {
                    $verification = $verification2;
                }
            }

            if (! $verification['ok']) {
                throw ValidationException::withMessages([
                    'otp_code' => [$verification['reason']],
                ]);
            }
        } else {
            throw ValidationException::withMessages([
                'otp_code' => ['Please enter and verify your OTP first.'],
            ]);
        }

        $user->forceFill([
            'password' => Hash::make($data['password']),
            'remember_token' => Str::random(60),
        ])->save();

        $sessions->revoke($user);

        $auditLogger->record(
            $user,
            'auth.password_reset_otp',
            User::class,
            $user->id,
        );

        return response()->json([
            'message' => 'Your password has been reset successfully. You can now log in with your new password.',
        ]);
    }
}
