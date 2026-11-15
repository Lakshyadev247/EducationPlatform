<?php

namespace App\Models;

use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable, SoftDeletes;

    /**
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'email',
        'phone',
        'password',
        'status',
        'last_login_at',
    ];

    /**
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'last_login_at' => 'datetime',
            'password' => 'hashed',
        ];
    }

    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class)
            ->withPivot(['assigned_by', 'assigned_at'])
            ->withTimestamps();
    }

    public function hasRole(string $role): bool
    {
        return $this->roles->contains('name', $role);
    }

    /**
     * @param  list<string>  $roles
     */
    public function hasAnyRole(array $roles): bool
    {
        return $this->roles->whereIn('name', $roles)->isNotEmpty();
    }

    public function isAdmin(): bool
    {
        return $this->hasAnyRole([Role::ADMIN, Role::SUPER_ADMIN]);
    }

    public function isSuperAdmin(): bool
    {
        return $this->hasRole(Role::SUPER_ADMIN);
    }

    public function studentProfile(): HasOne
    {
        return $this->hasOne(StudentProfile::class);
    }

    public function studentAddress(): HasOne
    {
        return $this->hasOne(StudentAddress::class, 'user_id', 'id');
    }

    public function teacherProfile(): HasOne
    {
        return $this->hasOne(TeacherProfile::class);
    }

    public function bookingsAsStudent(): HasMany
    {
        return $this->hasMany(Booking::class, 'student_id');
    }

    public function bookingsAsTeacher(): HasMany
    {
        return $this->hasMany(Booking::class, 'teacher_id');
    }

    public function reviewsWritten(): HasMany
    {
        return $this->hasMany(Review::class, 'student_id');
    }

    public function reviewsReceived(): HasMany
    {
        return $this->hasMany(Review::class, 'teacher_id');
    }

    public function notifications(): HasMany
    {
        return $this->hasMany(Notification::class);
    }

    public function termsAcceptances(): HasMany
    {
        return $this->hasMany(TermsAcceptance::class);
    }

    public function auditLogs(): HasMany
    {
        return $this->hasMany(AuditLog::class, 'actor_id');
    }
}
