<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\BookingResource;
use App\Models\Booking;
use App\Models\PlatformHoliday;
use App\Models\Role;
use App\Models\Subject;
use App\Models\TeacherAvailability;
use App\Models\TeacherUnavailableDate;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use App\Services\SettingsService;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class BookingController extends Controller
{
    public function __construct(
        private readonly NotificationService $notifications,
        private readonly SettingsService $settings,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $filters = $request->validate([
            'status' => ['nullable', Rule::in(['pending', 'accepted', 'rejected', 'cancelled', 'completed'])],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $user = $request->user();
        $query = Booking::query()
            ->with(['student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review'])
            ->orderByDesc('booking_date')
            ->orderByDesc('start_time');

        if ($user->hasRole(Role::TEACHER)) {
            $query->where('teacher_id', $user->id);
        } elseif ($user->hasRole(Role::STUDENT)) {
            $query->where('student_id', $user->id);
        } elseif (! $user->isAdmin()) {
            abort(403);
        } else {
            $query->where(function ($inner) use ($user): void {
                $inner->where('student_id', $user->id)->orWhere('teacher_id', $user->id);
            });
        }

        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        $bookings = $query->paginate((int) ($filters['per_page'] ?? 50))->withQueryString();

        return BookingResource::collection($bookings)->response();
    }

    public function show(Request $request, Booking $booking): BookingResource
    {
        $this->authorizeParticipant($request, $booking);

        return new BookingResource($booking->load([
            'student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review',
        ]));
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT), 403, 'Only students can create bookings.');

        // General setting: is the platform accepting new bookings at all?
        if (! (bool) ($this->settings->get('general.newBookingsAccepted', true))) {
            throw ValidationException::withMessages([
                'date' => ['The platform is not accepting new bookings at the moment.'],
            ]);
        }

        $data = $request->validate([
            'teacher_id' => ['required', 'integer', 'exists:users,id'],
            'subject_id' => ['nullable', 'integer', 'exists:subjects,id'],
            'subject' => ['nullable', 'string', 'max:100'],
            'date' => ['required', 'date_format:Y-m-d'],
            'time' => ['required', 'date_format:H:i'],
            'start_time' => ['nullable', 'date_format:H:i'],
            'mode' => ['required', Rule::in(['online', 'in-person'])],
            'booking_type' => ['nullable', Rule::in(['demo', 'monthly', 'course'])],
            'phone' => ['nullable', 'string', 'max:25'],
            'message' => ['nullable', 'string', 'max:300'],
            'duration_minutes' => ['nullable', 'integer', 'between:15,240'],
        ]);

        if (! empty($data['phone']) && empty($user->phone)) {
            $user->forceFill(['phone' => $data['phone']])->save();
        }

        $teacher = User::query()
            ->whereKey($data['teacher_id'])
            ->where('status', 'active')
            ->whereHas('roles', fn ($q) => $q->where('name', Role::TEACHER))
            ->with('teacherProfile')
            ->first();

        if ($teacher === null || $teacher->teacherProfile === null || ! $teacher->teacherProfile->is_public || $teacher->teacherProfile->approval_status !== 'approved') {
            throw ValidationException::withMessages(['teacher_id' => ['That teacher is not currently accepting bookings.']]);
        }

        $profile = $teacher->teacherProfile;
        $subject = $this->resolveSubject($data);
        if ($subject === null) {
            throw ValidationException::withMessages(['subject' => ['Choose a subject this teacher offers.']]);
        }

        $offered = $profile->subjects()->where('subjects.id', $subject->id)->exists();
        if (! $offered) {
            throw ValidationException::withMessages(['subject' => ['This teacher does not offer that subject.']]);
        }

        $start = $data['start_time'] ?? $data['time'];
        $duration = (int) ($data['duration_minutes'] ?? 60);
        $date = CarbonImmutable::createFromFormat('Y-m-d H:i', $data['date'].' '.$start, 'Asia/Kolkata');
        $end = $date->addMinutes($duration);

        if ($date->isPast()) {
            throw ValidationException::withMessages(['date' => ['Choose a lesson time in the future.']]);
        }

        if ($end->toDateString() !== $date->toDateString()) {
            throw ValidationException::withMessages(['time' => ['A lesson must finish before midnight.']]);
        }

        if ($profile->teaching_mode !== null && $profile->teaching_mode !== 'both' && $profile->teaching_mode !== $data['mode']) {
            throw ValidationException::withMessages(['mode' => ['This teacher does not offer that teaching mode.']]);
        }

        $holidayBlocked = (bool) ($this->settings->get('holidays.blockNewBookings', true));
        if ($holidayBlocked && PlatformHoliday::query()->whereDate('holiday_date', $date->toDateString())->exists()) {
            throw ValidationException::withMessages(['date' => ['That date is a platform holiday.']]);
        }

        if (TeacherUnavailableDate::query()
            ->where('teacher_profile_id', $profile->user_id)
            ->whereDate('unavailable_date', $date->toDateString())
            ->exists()) {
            throw ValidationException::withMessages(['date' => ['This teacher is unavailable on that date.']]);
        }

        $slot = TeacherAvailability::query()
            ->where('teacher_profile_id', $profile->user_id)
            ->where('day_of_week', $date->dayOfWeek)
            ->where('start_time', '<=', $start.':00')
            ->where('end_time', '>=', $end->format('H:i:s'))
            ->exists();

        if (! $slot) {
            // A teacher who has taken down every teaching day is not taking
            // lessons at the moment. The rule is the same either way - no
            // lesson can be requested - but the reason has to be the true one.
            $publishesHours = TeacherAvailability::query()
                ->where('teacher_profile_id', $profile->user_id)
                ->exists();

            throw ValidationException::withMessages(['time' => [$publishesHours
                ? 'That time is outside the teacher\'s published availability.'
                : 'This teacher is not taking lessons at the moment, so no lesson can be requested.']]);
        }

        $this->assertNoOverlap($teacher->id, null, $date, $end);

        try {
            $booking = DB::transaction(function () use ($user, $teacher, $subject, $data, $date, $start, $end, $duration): Booking {
                $bookingType = $data['booking_type'] ?? 'demo';
                $booking = Booking::query()->create([
                    'reference' => $this->uniqueReference(),
                    'student_id' => $user->id,
                    'teacher_id' => $teacher->id,
                    'subject_id' => $subject->id,
                    'booking_date' => $date->toDateString(),
                    'start_time' => $start.':00',
                    'end_time' => $end->format('H:i:s'),
                    'duration_minutes' => $duration,
                    'teaching_mode' => $data['mode'],
                    'booking_type' => $bookingType,
                    'status' => Booking::STATUS_PENDING,
                    'message' => $data['message'] ?? null,
                ]);

                $planLabel = match ($bookingType) {
                    'monthly' => 'Monthly regular tuition',
                    'course' => 'Full course tuition',
                    default => 'Demo lesson',
                };

                $this->notifications->send(
                    $teacher,
                    'booking-update',
                    'New '.$planLabel.' request',
                    $user->name.' requested '.$subject->name.' ('.$planLabel.') starting '.$date->format('d M Y').' at '.$start.'.',
                    'booking',
                    $booking->id,
                    'booking-created:'.$booking->id,
                );

                return $booking;
            });
        } catch (QueryException $exception) {
            if ($this->isDuplicate($exception)) {
                throw ValidationException::withMessages(['time' => ['That lesson slot has just been taken. Choose another time.']]);
            }
            throw $exception;
        }

        return (new BookingResource($booking->load([
            'student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review',
        ])))->response()->setStatusCode(201);
    }

    public function accept(Request $request, Booking $booking): BookingResource
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::TEACHER) && $booking->teacher_id === $user->id, 403);

        $booking->ensureCanTransitionTo(Booking::STATUS_ACCEPTED);

        $date = CarbonImmutable::createFromFormat('Y-m-d H:i:s', $booking->booking_date->toDateString().' '.$booking->start_time, 'Asia/Kolkata');
        if ($date->isPast()) {
            throw ValidationException::withMessages(['date' => ['That requested time has already passed.']]);
        }

        $end = $booking->end_time !== null
            ? CarbonImmutable::createFromFormat('Y-m-d H:i:s', $booking->booking_date->toDateString().' '.$booking->end_time, 'Asia/Kolkata')
            : $date->addMinutes($booking->duration_minutes);

        $this->assertNoOverlap($booking->teacher_id, $booking->id, $date, $end, true);

        $booking->forceFill([
            'status' => Booking::STATUS_ACCEPTED,
            'decided_at' => now(),
        ])->save();

        $this->notifications->send(
            $booking->student_id,
            'booking-update',
            'Lesson request accepted',
            'Your '.$booking->subject?->name.' request for '.$booking->booking_date->format('d M Y').' at '.substr($booking->start_time, 0, 5).' was accepted.',
            'booking',
            $booking->id,
            'booking-accepted:'.$booking->id,
        );

        return new BookingResource($booking->fresh(['student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review']));
    }

    public function reject(Request $request, Booking $booking): BookingResource
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::TEACHER) && $booking->teacher_id === $user->id, 403);

        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:400'],
        ]);

        $booking->ensureCanTransitionTo(Booking::STATUS_REJECTED);

        $booking->forceFill([
            'status' => Booking::STATUS_REJECTED,
            'rejection_reason' => $data['reason'] ?? null,
            'decided_at' => now(),
        ])->save();

        $this->notifications->send(
            $booking->student_id,
            'booking-update',
            'Lesson request declined',
            'Your '.$booking->subject?->name.' request for '.$booking->booking_date->format('d M Y').' was declined.',
            'booking',
            $booking->id,
            'booking-rejected:'.$booking->id,
        );

        return new BookingResource($booking->fresh(['student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review']));
    }

    public function cancel(Request $request, Booking $booking): BookingResource
    {
        $user = $request->user();
        $participant = $user->id === $booking->student_id || $user->id === $booking->teacher_id;
        abort_unless($participant || $user->isAdmin(), 403);

        $booking->ensureCanTransitionTo(Booking::STATUS_CANCELLED);

        $date = CarbonImmutable::createFromFormat('Y-m-d H:i:s', $booking->booking_date->toDateString().' '.$booking->start_time, 'Asia/Kolkata');
        if ($booking->status === Booking::STATUS_ACCEPTED && $date->isPast()) {
            throw ValidationException::withMessages(['status' => ['A lesson that has already started cannot be cancelled.']]);
        }

        $oldStatus = $booking->status;

        $booking->forceFill([
            'status' => Booking::STATUS_CANCELLED,
            'cancelled_at' => now(),
            'cancelled_by' => $user->id,
        ])->save();

        // An administrator cancelling somebody else's lesson is a privileged
        // intervention, so it is written to the audit trail. The attendance and
        // the review of that lesson are left exactly as they are.
        if (! $participant) {
            $this->auditLogger->record(
                $user,
                'booking.cancelled_by_admin',
                Booking::class,
                $booking->id,
                ['status' => $oldStatus],
                ['status' => Booking::STATUS_CANCELLED],
                'Cancelled by an administrator.',
            );
        }

        $other = $user->id === $booking->student_id ? $booking->teacher_id : $booking->student_id;

        $this->notifications->send(
            $other,
            'booking-update',
            'Lesson request cancelled',
            'The '.$booking->subject?->name.' lesson on '.$booking->booking_date->format('d M Y').' was cancelled by '.$user->name.'.',
            'booking',
            $booking->id,
            'booking-cancelled:'.$booking->id.':'.$user->id,
        );

        return new BookingResource($booking->fresh(['student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review']));
    }

    public function complete(Request $request, Booking $booking): BookingResource
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::TEACHER) && $booking->teacher_id === $user->id, 403);

        $booking->ensureCanTransitionTo(Booking::STATUS_COMPLETED);

        $date = CarbonImmutable::createFromFormat('Y-m-d H:i:s', $booking->booking_date->toDateString().' '.$booking->start_time, 'Asia/Kolkata');
        if ($date->isFuture()) {
            throw ValidationException::withMessages(['status' => ['A future lesson cannot be marked complete.']]);
        }

        $booking->forceFill([
            'status' => Booking::STATUS_COMPLETED,
            'completed_at' => now(),
        ])->save();

        return new BookingResource($booking->fresh(['student:id,name', 'teacher:id,name', 'subject:id,name', 'attendance', 'review']));
    }

    private function authorizeParticipant(Request $request, Booking $booking): void
    {
        $user = $request->user();
        abort_unless(
            $user->isAdmin() || $user->id === $booking->student_id || $user->id === $booking->teacher_id,
            403,
        );
    }

    private function resolveSubject(array $data): ?Subject
    {
        if (! empty($data['subject_id'])) {
            return Subject::query()->whereKey($data['subject_id'])->where('is_active', true)->first();
        }

        $name = trim((string) ($data['subject'] ?? ''));
        if ($name === '') {
            return null;
        }

        return Subject::query()
            ->where('is_active', true)
            ->where(fn ($q) => $q->where('name', $name)->orWhere('slug', $name)->orWhere('id', $name))
            ->first();
    }

    private function assertNoOverlap(int $teacherId, ?int $ignoreId, CarbonImmutable $start, CarbonImmutable $end, bool $acceptedOnly = false): void
    {
        $windowStart = $start->subMinutes(240)->toDateString();
        $windowEnd = $start->addDay()->toDateString();

        $bookings = Booking::query()
            ->where('teacher_id', $teacherId)
            ->whereIn('status', $acceptedOnly ? [Booking::STATUS_ACCEPTED] : [Booking::STATUS_PENDING, Booking::STATUS_ACCEPTED])
            ->whereBetween('booking_date', [$windowStart, $windowEnd])
            ->when($ignoreId !== null, fn ($q) => $q->whereKeyNot($ignoreId))
            ->get();

        foreach ($bookings as $existing) {
            $existingStart = CarbonImmutable::createFromFormat(
                'Y-m-d H:i:s',
                $existing->booking_date->toDateString().' '.$existing->start_time,
                'Asia/Kolkata',
            );
            $existingEnd = $existing->end_time !== null
                ? CarbonImmutable::createFromFormat('Y-m-d H:i:s', $existing->booking_date->toDateString().' '.$existing->end_time, 'Asia/Kolkata')
                : $existingStart->addMinutes($existing->duration_minutes);

            if ($existingStart < $end && $start < $existingEnd) {
                throw ValidationException::withMessages(['time' => ['That time overlaps another active lesson. Choose a different slot.']]);
            }
        }
    }

    private function uniqueReference(): string
    {
        do {
            $reference = 'BK-'.strtoupper(Str::random(10));
        } while (Booking::withTrashed()->where('reference', $reference)->exists());

        return $reference;
    }

    private function isDuplicate(QueryException $exception): bool
    {
        return in_array((string) $exception->getCode(), ['23000', '23505'], true)
            || str_contains(strtolower($exception->getMessage()), 'duplicate');
    }
}
