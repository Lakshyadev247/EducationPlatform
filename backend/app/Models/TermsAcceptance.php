<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TermsAcceptance extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'user_id',
        'terms_version_id',
        'role_at_acceptance',
        'accepted_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'accepted_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function termsVersion(): BelongsTo
    {
        return $this->belongsTo(TermsVersion::class);
    }
}
