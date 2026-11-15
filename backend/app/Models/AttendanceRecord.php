<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class AttendanceRecord extends Model
{
    use HasFactory;

    public const CONFIRMATION_PENDING = 'pending';

    public const CONFIRMATION_CONFIRMED = 'confirmed';

    public const CONFIRMATION_DISPUTED = 'disputed';

    public const ALLOWED_CONFIRMATION_TRANSITIONS = [
        self::CONFIRMATION_PENDING => [
            self::CONFIRMATION_CONFIRMED,
            self::CONFIRMATION_DISPUTED,
        ],
        self::CONFIRMATION_DISPUTED => [
            self::CONFIRMATION_CONFIRMED, // resolved via admin decision
        ],
        self::CONFIRMATION_CONFIRMED => [], // terminal confirmed
    ];

    /**
     * @var list<string>
     */
    protected $fillable = [
        'booking_id',
        'teacher_id',
        'student_id',
        'marked_by',
        'result',
        'current_result',
        'absence_reason',
        'marked_at',
        'confirmation',
        'student_response',
        'responded_at',
        'resolved_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'marked_at' => 'datetime',
            'responded_at' => 'datetime',
            'resolved_at' => 'datetime',
        ];
    }

    public function booking(): BelongsTo
    {
        return $this->belongsTo(Booking::class);
    }

    public function teacher(): BelongsTo
    {
        return $this->belongsTo(User::class, 'teacher_id');
    }

    public function student(): BelongsTo
    {
        return $this->belongsTo(User::class, 'student_id');
    }

    public function markedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'marked_by');
    }

    public function corrections(): HasMany
    {
        return $this->hasMany(AttendanceCorrection::class, 'attendance_id');
    }

    public function decisions(): HasMany
    {
        return $this->hasMany(AttendanceDecision::class, 'attendance_id');
    }

    public function canTransitionConfirmationTo(string $target): bool
    {
        if ($this->confirmation === $target) {
            return true;
        }

        $allowed = self::ALLOWED_CONFIRMATION_TRANSITIONS[$this->confirmation] ?? [];

        return in_array($target, $allowed, true);
    }

    public function isResolved(): bool
    {
        return $this->resolved_at !== null || $this->confirmation === self::CONFIRMATION_CONFIRMED;
    }
}
