<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TeacherUnavailableDate extends Model
{
    /**
     * @var list<string>
     */
    protected $fillable = [
        'teacher_profile_id',
        'unavailable_date',
        'reason',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'unavailable_date' => 'date',
        ];
    }

    public function teacherProfile(): BelongsTo
    {
        return $this->belongsTo(TeacherProfile::class);
    }
}
