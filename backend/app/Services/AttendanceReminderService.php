<?php

namespace App\Services;

use App\Models\AttendanceCorrection;
use App\Models\AttendanceRecord;
use App\Models\Notification;

/**
 * Attendance reminders, server-side.
 *
 * Reminders used to be generated entirely in the browser: the admin's
 * "Run reminders" button pushed notifications into an in-memory array and
 * reported a count that was never persisted, and the routine also ran on every
 * page load. This service owns the rule and writes real notifications through
 * NotificationService, which deduplicates on the key it is given.
 *
 * The rule mirrors the one the prototype used, so behaviour is preserved:
 *   - only records still awaiting the student's confirmation;
 *   - only records actually marked, at least `reminderDelayHours` ago;
 *   - never while a correction request is open (not actionable);
 *   - at most `maxReminderAttempts` reminders per record;
 *   - at least `reminderIntervalHours` between attempts.
 */
class AttendanceReminderService
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly NotificationService $notifications,
    ) {}

    /**
     * @return array{created: int, candidates: int, reason: ?string}
     */
    public function run(): array
    {
        if (! $this->settings->notificationEnabled('attendance-reminder')) {
            return ['created' => 0, 'candidates' => 0, 'reason' => 'category-disabled'];
        }

        $config = $this->settings->get('notifications', []);
        $delayHours = max(0, (int) ($config['reminderDelayHours'] ?? 6));
        $intervalHours = max(1, (int) ($config['reminderIntervalHours'] ?? 24));
        $maxAttempts = max(1, (int) ($config['maxReminderAttempts'] ?? 3));

        $due = AttendanceRecord::query()
            ->where('confirmation', AttendanceRecord::CONFIRMATION_PENDING)
            ->whereNotNull('marked_at')
            ->where('marked_at', '<=', now()->subHours($delayHours))
            ->get();

        $created = 0;
        $candidates = 0;

        foreach ($due as $record) {
            // An open correction means the record is under review, not actionable.
            $underReview = AttendanceCorrection::query()
                ->where('attendance_id', $record->id)
                ->where('status', 'pending')
                ->exists();

            if ($underReview) {
                continue;
            }

            $candidates++;

            $previous = Notification::query()
                ->where('user_id', $record->student_id)
                ->where('ref_type', 'attendance')
                ->where('ref_id', (string) $record->id)
                ->where('dedupe_key', 'like', 'reminder:%')
                ->orderByDesc('created_at')
                ->get();

            $sent = $previous->count();

            if ($sent >= $maxAttempts) {
                continue;
            }

            if ($sent > 0) {
                $last = $previous->first()->created_at;
                if ($last !== null && $last->diffInHours(now()) < $intervalHours) {
                    continue;
                }
            }

            $attempt = $sent + 1;

            $made = $this->notifications->send(
                $record->student_id,
                'attendance-reminder',
                'Confirm your attendance',
                'A lesson is waiting for you to confirm it. Open your attendance list to confirm or dispute it.',
                'attendance',
                $record->id,
                'reminder:'.$record->id.':attempt'.$attempt,
            );

            if ($made !== null) {
                $created++;
            }
        }

        return ['created' => $created, 'candidates' => $candidates, 'reason' => null];
    }
}
