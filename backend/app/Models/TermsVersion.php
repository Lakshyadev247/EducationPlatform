<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TermsVersion extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'audience',
        'version',
        'title',
        'body',
        'effective_date',
        'published_by',
        'published_at',
        'is_current',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'effective_date' => 'date',
            'published_at' => 'datetime',
            'is_current' => 'boolean',
        ];
    }

    public function publishedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'published_by');
    }

    public function acceptances(): HasMany
    {
        return $this->hasMany(TermsAcceptance::class);
    }
}
