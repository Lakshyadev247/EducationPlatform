<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Crypt;

class StorageProvider extends Model
{
    use HasFactory;

    protected $fillable = [
        'provider_key',
        'name',
        'driver_type',
        'is_active',
        'is_configured',
        'credentials',
        'settings',
        'status',
        'last_tested_at',
        'last_error',
        'metadata',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'is_configured' => 'boolean',
        'settings' => 'array',
        'metadata' => 'array',
        'last_tested_at' => 'datetime',
    ];

    public const SECRET_KEYS = [
        'secret_access_key',
        'account_key',
        'application_key',
        'private_key',
        'credentials_json',
        'access_token',
    ];

    /**
     * Encrypt sensitive fields when saving credentials.
     */
    public function setCredentialsAttribute(mixed $value): void
    {
        if (is_array($value)) {
            $encrypted = $value;
            foreach (self::SECRET_KEYS as $secretKey) {
                if (!empty($encrypted[$secretKey]) && is_string($encrypted[$secretKey])) {
                    // Do not re-encrypt if already a masked string
                    if ($encrypted[$secretKey] === '••••••••') {
                        unset($encrypted[$secretKey]); // Keep existing
                        continue;
                    }
                    $encrypted[$secretKey] = Crypt::encryptString($encrypted[$secretKey]);
                }
            }

            // If some secrets were preserved from existing credentials:
            $existing = $this->getRawOriginal('credentials');
            if ($existing) {
                $existingArray = json_decode($existing, true) ?: [];
                foreach (self::SECRET_KEYS as $secretKey) {
                    if (!isset($encrypted[$secretKey]) && !empty($existingArray[$secretKey])) {
                        $encrypted[$secretKey] = $existingArray[$secretKey];
                    }
                }
            }

            $this->attributes['credentials'] = json_encode($encrypted);
        } elseif (is_string($value)) {
            $this->attributes['credentials'] = $value;
        } else {
            $this->attributes['credentials'] = null;
        }
    }

    /**
     * Decrypt and return sensitive credentials for backend use.
     *
     * @return array<string, mixed>
     */
    public function getDecryptedCredentials(): array
    {
        $raw = json_decode($this->attributes['credentials'] ?? '{}', true) ?: [];
        $decrypted = $raw;

        foreach (self::SECRET_KEYS as $secretKey) {
            if (!empty($decrypted[$secretKey]) && is_string($decrypted[$secretKey])) {
                try {
                    $decrypted[$secretKey] = Crypt::decryptString($decrypted[$secretKey]);
                } catch (\Throwable) {
                    // In case it was already decrypted or legacy plain text
                }
            }
        }

        return $decrypted;
    }

    /**
     * Return masked credentials safe to send over the API.
     *
     * @return array<string, mixed>
     */
    public function getMaskedCredentials(): array
    {
        $raw = json_decode($this->attributes['credentials'] ?? '{}', true) ?: [];
        $masked = [];

        foreach ($raw as $key => $val) {
            if (in_array($key, self::SECRET_KEYS, true)) {
                $hasVal = !empty($val);
                $masked[$key] = $hasVal ? '••••••••' : '';
                $masked['has_' . $key] = $hasVal;
            } else {
                $masked[$key] = $val;
            }
        }

        return $masked;
    }

    public function documents(): HasMany
    {
        return $this->hasMany(StorageDocument::class, 'provider_key', 'provider_key');
    }

    public function logs(): HasMany
    {
        return $this->hasMany(StorageLog::class, 'provider_key', 'provider_key');
    }
}
