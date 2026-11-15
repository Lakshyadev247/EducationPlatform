<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TeacherProfile extends Model
{
    use HasFactory;

    protected $primaryKey = 'user_id';

    public $incrementing = false;

    protected $keyType = 'int';

    /**
     * @var list<string>
     */
    protected $fillable = [
        'user_id',
        'bio',
        'photo_path',
        'experience_level',
        'level_other',
        'experience_years',
        'experience_org',
        'experience_description',
        'teaching_mode',
        'online_tools',
        'timezone',
        'approval_status',
        'approved_at',
        'approved_by',
        'is_public',
        'completed_at',
        'id_document_id',
        'qualification_document_id',
        'document_verification_status',
        'document_verified_at',
        'document_verified_by',
        'document_rejection_reason',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'experience_years' => 'decimal:1',
            'approved_at' => 'datetime',
            'is_public' => 'boolean',
            'completed_at' => 'datetime',
            'document_verified_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function approvedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'approved_by');
    }

    public function documentVerifiedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'document_verified_by');
    }

    public function idDocument(): BelongsTo
    {
        return $this->belongsTo(StorageDocument::class, 'id_document_id');
    }

    public function qualificationDocument(): BelongsTo
    {
        return $this->belongsTo(StorageDocument::class, 'qualification_document_id');
    }

    public function subjects(): BelongsToMany
    {
        return $this->belongsToMany(Subject::class, 'teacher_subjects', 'teacher_profile_id', 'subject_id');
    }

    public function educationLevels(): BelongsToMany
    {
        return $this->belongsToMany(EducationLevel::class, 'teacher_education_levels', 'teacher_profile_id', 'education_level_id');
    }

    public function streams(): BelongsToMany
    {
        return $this->belongsToMany(Stream::class, 'teacher_streams', 'teacher_profile_id', 'stream_id');
    }

    public function qualifications(): HasMany
    {
        return $this->hasMany(TeacherQualification::class, 'teacher_profile_id');
    }

    public function serviceLocations(): HasMany
    {
        return $this->hasMany(TeacherServiceLocation::class, 'teacher_profile_id');
    }

    public function availability(): HasMany
    {
        return $this->hasMany(TeacherAvailability::class, 'teacher_profile_id');
    }

    public function prices(): HasMany
    {
        return $this->hasMany(TeacherPrice::class, 'teacher_profile_id');
    }

    public function unavailableDates(): HasMany
    {
        return $this->hasMany(TeacherUnavailableDate::class, 'teacher_profile_id');
    }

    public function settingOverrides(): HasMany
    {
        return $this->hasMany(TeacherSettingOverride::class, 'teacher_profile_id');
    }

    public function bookings(): HasMany
    {
        return $this->hasMany(Booking::class, 'teacher_id', 'user_id');
    }

    public function attendanceRecords(): HasMany
    {
        return $this->hasMany(AttendanceRecord::class, 'teacher_id', 'user_id');
    }

    public function reviews(): HasMany
    {
        return $this->hasMany(Review::class, 'teacher_id', 'user_id');
    }

    public function scopePubliclyVisible(Builder $query): Builder
    {
        return $query->where('is_public', true)->where('approval_status', 'approved');
    }

    /**
     * Compute a transparent diagnostic breakdown of why this teacher is (or is not)
     * currently bookable and discoverable by students in "Find Teachers".
     *
     * @return array<string, mixed>
     */
    public function getListingDiagnostic(?\App\Services\SettingsService $settings = null): array
    {
        $settings ??= app(\App\Services\SettingsService::class);
        $publicSettings = $settings->publicSettings();
        $requireDocs = (bool) ($publicSettings['general']['requireTeacherDocumentVerification'] ?? true);

        $userActive = $this->user?->status === 'active';
        $profileApproved = $this->approval_status === 'approved';
        $isPublic = (bool) $this->is_public;
        $docsVerified = ! $requireDocs || $this->document_verification_status === 'verified';
        $hasSubjects = $this->subjects()->exists();
        $hasAvailability = $this->availability()->exists();
        $hasTeachingMode = ! empty($this->teaching_mode);

        $checklist = [
            'account_active' => [
                'passed' => $userActive,
                'label' => 'User account is active',
            ],
            'profile_approved' => [
                'passed' => $profileApproved,
                'label' => 'Admin profile approval',
            ],
            'is_public' => [
                'passed' => $isPublic,
                'label' => 'Public listing flag enabled',
            ],
            'documents_verified' => [
                'passed' => $docsVerified,
                'required' => $requireDocs,
                'status' => $this->document_verification_status ?? 'not_uploaded',
                'label' => 'Identity & qualification document verification',
            ],
            'teaching_mode' => [
                'passed' => $hasTeachingMode,
                'label' => 'Teaching mode selected (Online / In-person)',
            ],
            'has_subjects' => [
                'passed' => $hasSubjects,
                'label' => 'At least one subject selected',
            ],
            'has_availability' => [
                'passed' => $hasAvailability,
                'label' => 'Weekly availability schedule configured',
            ],
        ];

        $missingReasons = [];
        if (! $userActive) {
            $missingReasons[] = 'Your user account is suspended or inactive.';
        }
        if (! $profileApproved) {
            if ($this->approval_status === 'rejected') {
                $missingReasons[] = 'Your teacher profile was rejected by administration.';
            } else {
                $missingReasons[] = 'Your profile is awaiting administrator approval.';
            }
        }
        if (! $isPublic && $profileApproved) {
            $missingReasons[] = 'Your profile visibility is currently turned off.';
        }
        if ($requireDocs && ! $docsVerified) {
            if ($this->document_verification_status === 'rejected') {
                $missingReasons[] = 'Your verification documents were rejected: '.($this->document_rejection_reason ?: 'Please re-upload.');
            } elseif ($this->document_verification_status === 'pending') {
                $missingReasons[] = 'Your verification documents are pending administrator review.';
            } else {
                $missingReasons[] = 'Please upload your ID and qualification documents for verification.';
            }
        }
        if (! $hasTeachingMode) {
            $missingReasons[] = 'Please select your teaching mode (Online or In-person).';
        }
        if (! $hasSubjects) {
            $missingReasons[] = 'You have not added any subjects you teach yet.';
        }
        if (! $hasAvailability) {
            $missingReasons[] = 'You have not added any teaching hours to your weekly schedule.';
        }

        $isBookable = $userActive && $profileApproved && $isPublic && $docsVerified && $hasTeachingMode && $hasSubjects && $hasAvailability;

        return [
            'is_bookable' => $isBookable,
            'is_publicly_visible' => $userActive && $profileApproved && $isPublic && $docsVerified,
            'approval_status' => $this->approval_status,
            'document_verification_status' => $this->document_verification_status ?? 'not_uploaded',
            'checklist' => $checklist,
            'missing_reasons' => $missingReasons,
        ];
    }
}
