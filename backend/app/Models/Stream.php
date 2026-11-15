<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Stream extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'key',
        'label',
        'sort_order',
        'is_active',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'sort_order' => 'integer',
            'is_active' => 'boolean',
        ];
    }

    public function teachers(): BelongsToMany
    {
        return $this->belongsToMany(TeacherProfile::class, 'teacher_streams');
    }
}
