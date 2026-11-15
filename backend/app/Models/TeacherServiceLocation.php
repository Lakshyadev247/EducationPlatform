<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TeacherServiceLocation extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'teacher_profile_id',
        'area',
        'city',
        'state',
        'country',
        'teaching_radius_km',
        'is_primary',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'teaching_radius_km' => 'integer',
            'is_primary' => 'boolean',
        ];
    }

    public function teacherProfile(): BelongsTo
    {
        return $this->belongsTo(TeacherProfile::class);
    }
}
