<?php

namespace App\Services;

use App\Models\OtpCode;
use App\Models\User;
use Illuminate\Support\Facades\Hash;

/**
 * One-time codes for the WhatsApp channel.
 *
 * Scope and honesty:
 *
 *  * This service generates, stores, expires, rate-limits and verifies codes.
 *    All of that is testable without any external account.
 *  * It does NOT pretend to deliver anything. `deliver()` reports whether a
 *    provider is actually configured, and when none is, the result is
 *    delivered=false with a reason. No message is claimed to have been sent.
 *
 * Credentials are read from the server environment only. Nothing secret is
 * stored in the database, returned in a response, or written to a log.
 */
class WhatsappOtpService
{
    /** A WhatsApp integration test — never satisfies an attendance challenge. */
    public const PURPOSE_TEST = 'whatsapp-test';

    /** A real lesson-attendance challenge. */
    public const PURPOSE_ATTENDANCE = 'attendance';

    /** Account creation verification. */
    public const PURPOSE_REGISTRATION = 'registration';

    /** Password recovery verification. */
    public const PURPOSE_PASSWORD_RESET = 'password-reset';

    public function __construct(private readonly SettingsService $settings) {}

    /**
     * Is a WhatsApp provider actually configured on this server?
     * Reads settings for the switches and the environment for the secrets.
     */
    public function providerStatus(): array
    {
        $w = $this->settings->get('whatsapp', []);

        $enabled = (bool) ($w['enabled'] ?? false);
        $phoneNumberId = trim((string) ($w['phoneNumberId'] ?? ''));
        $hasToken = trim((string) env('WHATSAPP_ACCESS_TOKEN', '')) !== '';

        $configured = $enabled && $phoneNumberId !== '' && $hasToken;

        return [
            'enabled' => $enabled,
            'provider' => (string) ($w['provider'] ?? 'meta-cloud-api'),
            // Presence only — never the value.
            'phoneNumberIdSet' => $phoneNumberId !== '',
            'accessTokenSet' => $hasToken,
            'configured' => $configured,
            'status' => $configured ? 'ready' : 'not-configured',
            'reason' => $configured
                ? null
                : 'WhatsApp Business Platform credentials are not present on this server. '
                  .'Set WHATSAPP_ACCESS_TOKEN in the server environment and the phone number ID in the admin settings.',
        ];
    }

    /**
     * Validate a recipient in E.164-ish form with an explicit country code.
     * The specification asks for a test recipient "including the country code".
     */
    public function normaliseRecipient(string $recipient): ?string
    {
        $digits = preg_replace('/[^0-9]/', '', $recipient) ?? '';

        // 8–15 digits is the E.164 range; a leading 0 is a national trunk prefix,
        // not a country code, so it is rejected rather than silently guessed.
        if (strlen($digits) < 8 || strlen($digits) > 15) {
            return null;
        }
        if (str_starts_with($digits, '0')) {
            return null;
        }

        return '+'.$digits;
    }

    /**
     * Issue a code. Returns the plaintext code once, for delivery. It is never
     * persisted — only its hash is.
     *
     * @return array{ok: bool, code: ?string, expiresAt: ?string, delivered: bool, reason: ?string}
     */
    public function issue(?User $user, string $purpose, string $recipient, ?int $ttlMinutes = null, ?int $maxAttempts = null): array
    {
        $otpSettings = $this->settings->get('otp', []);
        $w = $this->settings->get('whatsapp', []);
        $ttl = $ttlMinutes ?? max(1, (int) ($otpSettings['otpExpiryMinutes'] ?? $w['otpExpiryMinutes'] ?? 10));
        $limit = $maxAttempts ?? max(1, (int) ($otpSettings['otpMaxAttempts'] ?? $w['otpMaxAttempts'] ?? 5));

        $normalised = $this->normaliseRecipient($recipient);
        if ($normalised === null) {
            return ['ok' => false, 'code' => null, 'expiresAt' => null, 'delivered' => false,
                'reason' => 'A valid recipient with a country code is required (8–15 digits, no leading zero).'];
        }

        // Supersede any live code for the same purpose & recipient or user: one active code at a time.
        $query = OtpCode::query()
            ->where('purpose', $purpose)
            ->whereNull('consumed_at');

        if ($user !== null) {
            $query->where(function ($q) use ($user, $normalised) {
                $q->where('user_id', $user->id)
                  ->orWhere('recipient', $normalised);
            });
        } else {
            $query->where('recipient', $normalised);
        }

        $query->update(['consumed_at' => now()]);

        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);

        OtpCode::query()->create([
            'user_id' => $user?->id,
            'purpose' => $purpose,
            'channel' => 'whatsapp',
            'recipient' => $normalised,
            'code_hash' => Hash::make($code),
            'max_attempts' => $limit,
            'expires_at' => now()->addMinutes($ttl),
        ]);

        $delivery = $this->deliver($normalised, $code, $purpose);

        return [
            'ok' => true,
            'code' => $code,
            'expiresAt' => now()->addMinutes($ttl)->toIso8601String(),
            'delivered' => $delivery['delivered'],
            'reason' => $delivery['reason'],
        ];
    }

    /**
     * Attempt delivery. Without a configured provider this reports failure
     * rather than inventing a success.
     */
    private function deliver(string $recipient, string $code, string $purpose): array
    {
        $status = $this->providerStatus();

        if (! $status['configured']) {
            return ['delivered' => false, 'reason' => $status['reason']];
        }

        // A provider IS configured. The actual HTTP call to the Meta WhatsApp
        // Business Platform belongs here and has not been exercised, because no
        // credentials or approved test recipient are available in this
        // environment. Reporting delivered=true at this point would be a
        // fabricated result, so it is reported as not attempted.
        return [
            'delivered' => false,
            'reason' => 'A provider is configured but no real send was performed by this build. '
                .'Provider delivery is unverified.',
        ];
    }

    /**
     * Verify a code. Enforces expiry, attempt limits and one-time use.
     *
     * @return array{ok: bool, reason: ?string}
     */
    public function verify(?User $user, string $purpose, string $code, ?string $recipient = null): array
    {
        $query = OtpCode::query()
            ->where('purpose', $purpose)
            ->whereNull('consumed_at');

        if ($recipient !== null) {
            $normalised = $this->normaliseRecipient($recipient);
            if ($normalised === null) {
                return ['ok' => false, 'reason' => 'A valid recipient with a country code is required.'];
            }
            $query->where('recipient', $normalised);
        } elseif ($user !== null) {
            $query->where('user_id', $user->id);
        } else {
            return ['ok' => false, 'reason' => 'A user or recipient phone number is required.'];
        }

        $row = $query->latest('id')->first();

        if ($row === null) {
            return ['ok' => false, 'reason' => 'No active code. Request a new one.'];
        }

        if ($row->expires_at !== null && $row->expires_at->isPast()) {
            $row->update(['consumed_at' => now()]);

            return ['ok' => false, 'reason' => 'That code has expired. Request a new one.'];
        }

        if ($row->attempts >= $row->max_attempts) {
            $row->update(['consumed_at' => now()]);

            return ['ok' => false, 'reason' => 'Too many incorrect attempts. Request a new code.'];
        }

        $row->increment('attempts');

        if (! Hash::check($code, $row->code_hash)) {
            $remaining = max(0, $row->max_attempts - ($row->attempts));
            $row->refresh();

            if ($row->attempts >= $row->max_attempts) {
                $row->update(['consumed_at' => now()]);

                return ['ok' => false, 'reason' => 'Too many incorrect attempts. Request a new code.'];
            }

            return ['ok' => false, 'reason' => "That code is not correct. {$remaining} attempt(s) left."];
        }

        // One-time use.
        $row->update(['consumed_at' => now()]);

        return ['ok' => true, 'reason' => null];
    }
}
