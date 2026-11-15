<?php

namespace App\Services;

use App\Models\AttendanceRecord;
use App\Models\Booking;
use App\Models\Review;
use App\Models\User;

class ReviewEligibilityService
{
    public function __construct(private readonly SettingsService $settings) {}

    /**
     * @return array{eligible: bool, reason: string, completed_lessons: int, confirmed_days: int, existing_review_id: int|null}
     */
    public function evaluate(User $student, int $teacherId, ?int $bookingId = null): array
    {
        // The policy that applies is the effective one: the platform rules
        // with the overrides of this teacher merged into them. Without it a
        // teacher whose review policy was opened for them alone would still
        // be judged by the platform rules alone.
        $effective = $this->settings->effectiveFor($teacherId);
        $policy = $effective['eligibility'] ?? [];
        $configured = (bool) ($policy['configured'] ?? false);

        $completedLessons = Booking::query()
            ->where('student_id', $student->id)
            ->where('teacher_id', $teacherId)
            ->where('status', Booking::STATUS_COMPLETED)
            ->count();

        $confirmedDays = AttendanceRecord::query()
            ->where('student_id', $student->id)
            ->where('teacher_id', $teacherId)
            ->where('confirmation', AttendanceRecord::CONFIRMATION_CONFIRMED)
            ->where('current_result', 'present')
            ->distinct('booking_id')
            ->count('booking_id');

        $base = [
            'eligible' => false,
            'reason' => '',
            'completed_lessons' => $completedLessons,
            'confirmed_days' => $confirmedDays,
            'existing_review_id' => null,
        ];

        if (! $configured) {
            return array_merge($base, [
                'reason' => 'Review eligibility has not been configured by an administrator yet.',
            ]);
        }

        if ($bookingId !== null) {
            $booking = Booking::query()
                ->whereKey($bookingId)
                ->where('student_id', $student->id)
                ->where('teacher_id', $teacherId)
                ->first();

            if ($booking === null) {
                return array_merge($base, ['reason' => 'That lesson does not belong to you.']);
            }

            if ($booking->status !== Booking::STATUS_COMPLETED) {
                return array_merge($base, ['reason' => 'This lesson has not been completed yet.']);
            }

            // The lesson itself has to be proven: only attendance that both
            // sides confirmed and that says the student was present counts.
            // The confirmed days of the whole history are the policy
            // threshold, not the evidence for this one lesson. Without this
            // check a student could review a lesson whose attendance record
            // was still pending, disputed or absent, as long as some other
            // lesson with the same teacher was confirmed.
            $lessonConfirmed = AttendanceRecord::query()
                ->where('booking_id', $booking->id)
                ->where('student_id', $student->id)
                ->where('teacher_id', $teacherId)
                ->where('confirmation', AttendanceRecord::CONFIRMATION_CONFIRMED)
                ->where('current_result', 'present')
                ->exists();

            if (! $lessonConfirmed) {
                return array_merge($base, [
                    'reason' => 'The attendance for this lesson is not confirmed yet, so it cannot be reviewed.',
                ]);
            }

            // One review per completed lesson. The same student may review the
            // same teacher again for a different completed lesson.
            $existing = Review::query()
                ->where('student_id', $student->id)
                ->where('booking_id', $booking->id)
                ->first();

            if ($existing !== null) {
                return array_merge($base, [
                    'reason' => 'You have already reviewed this lesson.',
                    'existing_review_id' => $existing->id,
                ]);
            }
        }

        if ((bool) ($policy['requireCompletedBooking'] ?? true) && $completedLessons < 1) {
            return array_merge($base, ['reason' => 'Complete at least one lesson with this teacher first.']);
        }

        $type = $policy['type'] ?? 'study-days';

        if ($type === 'study-days') {
            $minimum = max(1, (int) ($policy['minConfirmedDays'] ?? 1));
            if ($confirmedDays < $minimum) {
                return array_merge($base, [
                    'reason' => 'You need '.$minimum.' mutually confirmed study day(s) before reviewing.',
                ]);
            }
        } elseif ($type === 'completed-lessons') {
            $minimum = max(1, (int) ($policy['minCompletedLessons'] ?? 1));
            if ($completedLessons < $minimum) {
                return array_merge($base, [
                    'reason' => 'You need '.$minimum.' completed lesson(s) before reviewing.',
                ]);
            }
        }

        return array_merge($base, ['eligible' => true]);
    }
}
