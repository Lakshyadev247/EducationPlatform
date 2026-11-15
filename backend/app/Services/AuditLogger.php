<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Support\Str;

class AuditLogger
{
    /**
     * Keys that are sensitive on their own.
     */
    private const SENSITIVE_EXACT = [
        'pin',
        'otp',
        'jwt',
        'iv',
    ];

    /**
     * Word fragments that make a key sensitive when they appear as a word or as
     * part of a compound key (e.g. accessToken, api_key, clientSecret,
     * newPassword, whatsappToken, x_api_key).
     */
    private const SENSITIVE_PARTS = [
        'password',
        'passwd',
        'passphrase',
        'secret',
        'token',
        'apikey',
        'api',
        'key',
        'credential',
        'credentials',
        'authorization',
        'authorisation',
        'bearer',
        'signature',
        'privatekey',
        'accesskey',
        'sessionid',
        'remembertoken',
    ];

    /**
     * Keys that look sensitive but are legitimate, non-secret audit data.
     * Checked before the sensitive rules so they are preserved.
     */
    private const ALLOWED_KEYS = [
        'credentialsource',
        'apikeyenabled',
        'tokenexpiry',
        'keyname',
        'passwordchangedat',
        'otpexpiry',
        'otpexpiryminutes',
        'otpmaxattempts',
    ];

    private const MASK = '[redacted]';

    /**
     * @param  array<string, mixed>  $oldValues
     * @param  array<string, mixed>  $newValues
     */
    public function record(
        ?User $actor,
        string $action,
        string $entityType,
        string|int|null $entityId,
        array $oldValues = [],
        array $newValues = [],
        ?string $reason = null,
    ): AuditLog {
        return AuditLog::query()->create([
            'actor_id' => $this->actorId($actor),
            'action' => $action,
            'entity_type' => $entityType,
            'entity_id' => $entityId === null ? null : (string) $entityId,
            // Redact before storing. Audit entries must never carry raw
            // passwords, tokens, API secrets or OTPs, at any nesting depth.
            'old_values' => $oldValues === [] ? null : $this->redactArray($oldValues),
            'new_values' => $newValues === [] ? null : $this->redactArray($newValues),
            'reason' => $reason,
            'ip_address' => request()->ip(),
            'user_agent' => Str::limit((string) request()->userAgent(), 1000, ''),
        ]);
    }

    /**
     * The id of the account that caused the entry.
     *
     * A restore can replace the database and take the acting account with
     * it. The entry is still written, but without an actor, because the
     * foreign key would otherwise refuse it.
     */
    private function actorId(?User $actor): ?int
    {
        if ($actor === null) {
            return null;
        }

        $key = $actor->getKey();

        if ($key === null) {
            return null;
        }

        return User::query()->whereKey($key)->exists() ? (int) $key : null;
    }

    /**
     * Recursively redact a value. Arrays are walked by key; list values keep
     * their shape so the audit trail stays readable.
     */
    public function redact(mixed $value, ?string $key = null): mixed
    {
        if (is_array($value)) {
            return $this->redactArray($value);
        }

        if ($key !== null && $this->isSensitiveKey($key)) {
            return $value === null || $value === '' ? $value : self::MASK;
        }

        return $value;
    }

    /**
     * @param  array<mixed>  $values
     * @return array<mixed>
     */
    private function redactArray(array $values): array
    {
        $out = [];

        foreach ($values as $key => $value) {
            if (is_array($value)) {
                // Recurse, and carry the key down so a sensitive key holding an
                // array (e.g. "credentials" => [...]) is masked wholesale.
                $out[$key] = $this->isSensitiveKey((string) $key)
                    ? self::MASK
                    : $this->redactArray($value);

                continue;
            }

            $out[$key] = $this->redact($value, is_string($key) ? $key : null);
        }

        return $out;
    }

    /**
     * True when a key looks like it carries a credential.
     *
     * Comparison is word-aware: camelCase and snake_case keys are split into
     * words and each word is tested, so accessToken, api_key, clientSecret and
     * newPassword are all caught while unrelated keys are left alone.
     */
    private function isSensitiveKey(string $key): bool
    {
        $normalised = strtolower(str_replace(['-', ' ', '.'], '_', $key));

        // Allow-list wins: these look sensitive but are legitimate audit data.
        if (in_array(str_replace('_', '', $normalised), self::ALLOWED_KEYS, true)) {
            return false;
        }

        if (in_array($normalised, self::SENSITIVE_EXACT, true)) {
            return true;
        }

        // split camelCase / snake_case / digit boundaries into words
        $spaced = preg_replace('/([a-z0-9])([A-Z])/', '$1 $2', $key);
        $spaced = preg_replace('/([A-Za-z])([0-9])/', '$1 $2', (string) $spaced);
        $words = preg_split('/[^a-zA-Z]+/', strtolower((string) $spaced), -1, PREG_SPLIT_NO_EMPTY) ?: [];

        foreach ($words as $word) {
            if (in_array($word, self::SENSITIVE_EXACT, true)) {
                return true;
            }
            if (in_array($word, self::SENSITIVE_PARTS, true)) {
                return true;
            }
        }

        // compound keys with no separator, e.g. apikey / accesstoken
        $joined = str_replace('_', '', $normalised);
        foreach (self::SENSITIVE_PARTS as $part) {
            if (strlen($part) >= 5 && str_contains($joined, $part)) {
                return true;
            }
        }

        return false;
    }
}
