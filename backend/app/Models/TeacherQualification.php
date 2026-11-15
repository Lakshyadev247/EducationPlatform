<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TeacherQualification extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'teacher_profile_id',
        'name',
        'institution',
        'year_completed',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'year_completed' => 'integer',
        ];
    }

    public function teacherProfile(): BelongsTo
    {
        return $this->belongsTo(TeacherProfile::class);
    }
}
