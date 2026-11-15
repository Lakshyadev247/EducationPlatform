<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;

class Booking extends Model
{
    use HasFactory, SoftDeletes;

    public const STATUS_PENDING = 'pending';

    public const STATUS_ACCEPTED = 'accepted';

    public const STATUS_REJECTED = 'rejected';

    public const STATUS_CANCELLED = 'cancelled';

    public const STATUS_COMPLETED = 'completed';

    public const TYPE_DEMO = 'demo';

    public const TYPE_MONTHLY = 'monthly';

    public const TYPE_COURSE = 'course';

    /**
     * Formal transition matrix defining allowed status progressions.
     * Prevents invalid state leaps (e.g. cancelled -> completed).
     */
    public const ALLOWED_TRANSITIONS = [
        self::STATUS_PENDING => [
            self::STATUS_ACCEPTED,
            self::STATUS_REJECTED,
            self::STATUS_CANCELLED,
        ],
        self::STATUS_ACCEPTED => [
            self::STATUS_COMPLETED,
            self::STATUS_CANCELLED,
            self::STATUS_ACCEPTED, // allow re-updating pricing / administrative assignment details
        ],
        self::STATUS_REJECTED => [],
        self::STATUS_CANCELLED => [],
        self::STATUS_COMPLETED => [],
    ];

    /**
     * @var list<string>
     */
    protected $fillable = [
        'reference',
        'student_id',
        'teacher_id',
        'subject_id',
        'booking_date',
        'start_time',
        'end_time',
        'duration_minutes',
        'teaching_mode',
        'booking_type',
        'status',
        'agreed_price',
        'pricing_type',
        'message',
        'rejection_reason',
        'admin_notes',
        'decided_at',
        'approved_by',
        'approved_at',
        'cancelled_at',
        'cancelled_by',
        'completed_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'booking_date' => 'date',
            'duration_minutes' => 'integer',
            'agreed_price' => 'decimal:2',
            'decided_at' => 'datetime',
            'approved_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'completed_at' => 'datetime',
        ];
    }

    public function student(): BelongsTo
    {
        return $this->belongsTo(User::class, 'student_id');
    }

    public function teacher(): BelongsTo
    {
        return $this->belongsTo(User::class, 'teacher_id');
    }

    public function subject(): BelongsTo
    {
        return $this->belongsTo(Subject::class);
    }

    public function cancelledBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'cancelled_by');
    }

    public function approvedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'approved_by');
    }

    public function attendance(): HasOne
    {
        return $this->hasOne(AttendanceRecord::class);
    }

    public function review(): HasOne
    {
        return $this->hasOne(Review::class);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->whereIn('status', [self::STATUS_PENDING, self::STATUS_ACCEPTED]);
    }

    public function canTransitionTo(string $targetStatus): bool
    {
        if ($this->status === $targetStatus) {
            return true;
        }

        $allowed = self::ALLOWED_TRANSITIONS[$this->status] ?? [];

        return in_array($targetStatus, $allowed, true);
    }

    public function isTerminal(): bool
    {
        return in_array($this->status, [self::STATUS_REJECTED, self::STATUS_CANCELLED, self::STATUS_COMPLETED], true);
    }

    public function ensureCanTransitionTo(string $targetStatus): void
    {
        if (! $this->canTransitionTo($targetStatus)) {
            throw \Illuminate\Validation\ValidationException::withMessages([
                'status' => [
                    sprintf(
                        'Cannot transition booking from "%s" to "%s". Current state is %s.',
                        $this->status,
                        $targetStatus,
                        $this->isTerminal() ? 'terminal' : 'not eligible'
                    ),
                ],
            ]);
        }
    }
}
