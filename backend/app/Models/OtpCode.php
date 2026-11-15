<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A one-time code. Only the hash is stored; the plaintext is never persisted.
 */
class OtpCode extends Model
{
    protected $fillable = [
        'user_id',
        'purpose',
        'channel',
        'recipient',
        'code_hash',
        'attempts',
        'max_attempts',
        'expires_at',
        'consumed_at',
    ];

    protected function casts(): array
    {
        return [
            'expires_at' => 'datetime',
            'consumed_at' => 'datetime',
            'attempts' => 'integer',
            'max_attempts' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
