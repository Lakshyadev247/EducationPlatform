<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\AttendanceResource;
use App\Models\AttendanceCorrection;
use App\Models\AttendanceRecord;
use App\Models\Booking;
use App\Models\Role;
use App\Services\NotificationService;
use App\Services\SettingsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class AttendanceController extends Controller
{
    public function __construct(
        private readonly NotificationService $notifications,
        private readonly SettingsService $settings,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $query = AttendanceRecord::query()
            ->with([
                'booking.subject',
                'teacher:id,name',
                'student:id,name',
                'corrections',
                'decisions',
            ])
            ->orderByDesc('marked_at');

        if ($user->hasRole(Role::TEACHER)) {
            $query->where('teacher_id', $user->id);
        } elseif ($user->hasRole(Role::STUDENT)) {
            $query->where('student_id', $user->id);
        } elseif (! $user->isAdmin()) {
            abort(403);
        }

        $records = $query->paginate(100)->withQueryString();

        return AttendanceResource::collection($records)->response();
    }

    public function show(Request $request, AttendanceRecord $attendance): AttendanceResource
    {
        $this->authorizeParticipant($request, $attendance);

        return new AttendanceResource($attendance->load([
            'booking.subject', 'teacher:id,name', 'student:id,name', 'corrections', 'decisions',
        ]));
    }

    /**
     * Which confirmation the platform requires. Defaults to the behaviour that
     * existed before the setting was introduced, so nothing changes unless an
     * administrator chooses otherwise.
     */
    private function verificationMethod(): string
    {
        $method = (string) $this->settings->get('attendance.verificationMethod', 'teacher-and-student');

        return in_array($method, ['teacher-and-student', 'teacher-only'], true)
            ? $method
            : 'teacher-and-student';
    }

    /**
     * The confirmation the platform requires for one teacher's lessons.
     *
     * A teacher may have the method overridden for their own lessons, but a
     * method that is not a valid one falls back to the platform default.
     */
    private function verificationMethodFor(?int $teacherId): string
    {
        if ($teacherId === null) {
            return $this->verificationMethod();
        }

        $method = (string) ($this->settings->effectiveFor($teacherId)['attendance']['verificationMethod'] ?? 'teacher-and-student');

        return in_array($method, ['teacher-and-student', 'teacher-only'], true)
            ? $method
            : 'teacher-and-student';
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::TEACHER), 403);

        $data = $request->validate([
            'booking_id' => ['required', 'integer', 'exists:bookings,id'],
            'result' => ['required', Rule::in(['present', 'absent'])],
            'reason' => ['nullable', 'string', 'max:240'],
        ]);

        // Platform-wide switch. When attendance recording is off, no lesson
        // can be marked at all and no teacher override can re-enable it.
        if (! (bool) $this->settings->get('attendance.verificationEnabled', true)) {
            throw ValidationException::withMessages([
                'booking_id' => ['Attendance recording is switched off for the whole platform at the moment.'],
            ]);
        }

        $booking = Booking::query()->with(['subject', 'student:id,name'])->findOrFail($data['booking_id']);
        abort_unless($booking->teacher_id === $user->id, 403);

        // A teacher may have attendance switched off for their own lessons.
        if (! (bool) ($this->settings->effectiveFor($booking->teacher_id)['attendance']['verificationEnabled'] ?? true)) {
            throw ValidationException::withMessages([
                'booking_id' => ['Attendance recording is switched off for this teacher at the moment.'],
            ]);
        }

        if (! in_array($booking->status, [Booking::STATUS_ACCEPTED, Booking::STATUS_COMPLETED], true)) {
            throw ValidationException::withMessages(['booking_id' => ['Attendance can only be recorded for an accepted or completed lesson.']]);
        }

        if ($booking->booking_date->isFuture()) {
            throw ValidationException::withMessages(['booking_id' => ['Attendance cannot be recorded before the lesson date.']]);
        }

        if (AttendanceRecord::query()->where('booking_id', $booking->id)->exists()) {
            throw ValidationException::withMessages(['booking_id' => ['Attendance for that lesson has already been recorded.']]);
        }

        $reason = trim((string) ($data['reason'] ?? ''));
        $requireReason = (bool) ($this->settings->effectiveFor($booking->teacher_id)['attendance']['requireReasonWhenLessonMissed'] ?? true);

        if ($data['result'] === 'absent' && $requireReason && $reason === '') {
            throw ValidationException::withMessages(['reason' => ['Explain why the lesson was missed.']]);
        }

        $record = DB::transaction(function () use ($booking, $data, $user, $reason, $requireReason): AttendanceRecord {
            $record = AttendanceRecord::query()->create([
                'booking_id' => $booking->id,
                'teacher_id' => $booking->teacher_id,
                'student_id' => $booking->student_id,
                'marked_by' => $user->id,
                'result' => $data['result'],
                'current_result' => $data['result'],
                'absence_reason' => $data['result'] === 'absent' ? ($reason !== '' ? $reason : ($requireReason ? null : 'No reason provided.')) : null,
                'marked_at' => now(),
                // Verification policy decides whether the student still has to
                // confirm. Under 'teacher-only' the teacher's mark is final, so
                // the record is confirmed immediately; otherwise it waits for
                // the student. Disputes remain available either way.
                'confirmation' => $this->verificationMethodFor($booking->teacher_id) === 'teacher-only'
                    ? AttendanceRecord::CONFIRMATION_CONFIRMED
                    : AttendanceRecord::CONFIRMATION_PENDING,
                'responded_at' => $this->verificationMethodFor($booking->teacher_id) === 'teacher-only' ? now() : null,
            ]);

            $this->notifications->send(
                $booking->student_id,
                'attendance-reminder',
                'Attendance recorded',
                'Your teacher recorded '.$data['result'].' for '.$booking->subject?->name.' on '.$booking->booking_date->format('d M Y').'. Please confirm or dispute it.',
                'attendance',
                $record->id,
                'attendance-recorded:'.$booking->id,
            );

            return $record;
        });

        return (new AttendanceResource($record->load([
            'booking.subject', 'teacher:id,name', 'student:id,name', 'corrections', 'decisions',
        ])))->response()->setStatusCode(201);
    }

    public function confirm(Request $request, AttendanceRecord $attendance): AttendanceResource
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT) && $attendance->student_id === $user->id, 403);

        if ($attendance->confirmation !== AttendanceRecord::CONFIRMATION_PENDING) {
            throw ValidationException::withMessages(['confirmation' => ['Only records awaiting your confirmation can be confirmed.']]);
        }

        $attendance->forceFill([
            'confirmation' => AttendanceRecord::CONFIRMATION_CONFIRMED,
            'responded_at' => now(),
        ])->save();

        return new AttendanceResource($attendance->fresh([
            'booking.subject', 'teacher:id,name', 'student:id,name', 'corrections', 'decisions',
        ]));
    }

    public function dispute(Request $request, AttendanceRecord $attendance): AttendanceResource
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT) && $attendance->student_id === $user->id, 403);

        $data = $request->validate([
            'response' => ['required', 'string', 'min:3', 'max:400'],
        ]);

        // Under 'teacher-only' the teacher's mark is final, so the record is
        // already confirmed by the time the student sees it. The student must
        // still be able to challenge it, or choosing that policy would silently
        // remove an existing protection. Under 'teacher-and-student' the original
        // rule stands: only a record awaiting confirmation can be disputed.
        $disputable = $this->verificationMethodFor($attendance->teacher_id) === 'teacher-only'
            ? [AttendanceRecord::CONFIRMATION_PENDING, AttendanceRecord::CONFIRMATION_CONFIRMED]
            : [AttendanceRecord::CONFIRMATION_PENDING];

        if (! in_array($attendance->confirmation, $disputable, true)) {
            throw ValidationException::withMessages(['confirmation' => ['Only records awaiting your confirmation can be disputed.']]);
        }

        $attendance->forceFill([
            'confirmation' => AttendanceRecord::CONFIRMATION_DISPUTED,
            'student_response' => trim($data['response']),
            'responded_at' => now(),
        ])->save();

        // The dispute alert is an independent switch. The general notification
        // setting for the category still applies on top of it: the message is
        // only sent when both are on.
        if ((bool) $this->settings->get('notifications.notifyAdminsOnDispute', true)) {
            $this->notifications->sendToAdmins(
                'dispute-opened',
                'Attendance dispute opened',
                $user->name.' disputed the attendance record for booking '.$attendance->booking->reference.'.',
                'attendance',
                $attendance->id,
                'dispute-opened:'.$attendance->id,
            );
        }

        return new AttendanceResource($attendance->fresh([
            'booking.subject', 'teacher:id,name', 'student:id,name', 'corrections', 'decisions',
        ]));
    }

    public function requestCorrection(Request $request, AttendanceRecord $attendance): JsonResponse
    {
        $user = $request->user();
        $role = $user->hasRole(Role::STUDENT) && $attendance->student_id === $user->id
            ? 'student'
            : ($user->hasRole(Role::TEACHER) && $attendance->teacher_id === $user->id ? 'teacher' : null);

        abort_if($role === null, 403);

        $data = $request->validate([
            'explanation' => ['required', 'string', 'min:5', 'max:400'],
        ]);

        $open = AttendanceCorrection::query()
            ->where('attendance_id', $attendance->id)
            ->where('requester_id', $user->id)
            ->where('status', 'pending')
            ->exists();

        if ($open) {
            throw ValidationException::withMessages(['explanation' => ['You already have a correction request open for this record.']]);
        }

        $correction = AttendanceCorrection::query()->create([
            'attendance_id' => $attendance->id,
            'requester_id' => $user->id,
            'requester_role' => $role,
            'explanation' => trim($data['explanation']),
            'status' => 'pending',
        ]);

        $this->notifications->sendToAdmins(
            'dispute-opened',
            'Attendance correction requested',
            $user->name.' requested a correction for booking '.$attendance->booking->reference.'.',
            'attendance',
            $attendance->id,
            'correction-opened:'.$correction->id,
        );

        return response()->json([
            'data' => [
                'id' => $correction->id,
                'attendance_id' => $correction->attendance_id,
                'requester_id' => $correction->requester_id,
                'requester_role' => $correction->requester_role,
                'explanation' => $correction->explanation,
                'status' => $correction->status,
                'created_at' => $correction->created_at?->toIso8601String(),
            ],
        ], 201);
    }

    private function authorizeParticipant(Request $request, AttendanceRecord $attendance): void
    {
        $user = $request->user();
        abort_unless(
            $user->isAdmin() || $user->id === $attendance->student_id || $user->id === $attendance->teacher_id,
            403,
        );
    }
}
