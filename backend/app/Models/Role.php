<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Role extends Model
{
    public const STUDENT = 'student';

    public const TEACHER = 'teacher';

    public const ADMIN = 'admin';

    public const SUPER_ADMIN = 'super_admin';

    /**
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'label',
        'rank',
        // 'is_privileged' is deliberately NOT mass-assignable. It decides whether
        // a role grants elevated access (UserPolicy reads it), so allowing it
        // through fill() would let a crafted payload escalate privilege.
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'rank' => 'integer',
            'is_privileged' => 'boolean',
        ];
    }

    public function users(): BelongsToMany
    {
        return $this->belongsToMany(User::class)
            ->withPivot(['assigned_by', 'assigned_at'])
            ->withTimestamps();
    }
}
