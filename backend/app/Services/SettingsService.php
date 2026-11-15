<?php

namespace App\Services;

use App\Models\Setting;
use App\Models\TeacherSettingOverride;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class SettingsService
{
    /**
     * @return array<string, mixed>
     */
    public function all(): array
    {
        return Setting::query()
            ->orderBy('key')
            ->get()
            ->mapWithKeys(fn (Setting $setting): array => [$setting->key => $setting->value])
            ->all();
    }

    public function get(string $key, mixed $default = null): mixed
    {
        $all = $this->all();

        if (array_key_exists($key, $all)) {
            return $all[$key];
        }

        $value = $all;
        foreach (explode('.', $key) as $segment) {
            if (! is_array($value) || ! array_key_exists($segment, $value)) {
                return $default;
            }

            $value = $value[$segment];
        }

        return $value;
    }

    /**
     * The settings that apply to one teacher: the platform defaults with that
     * teacher's own overrides on top.
     *
     * An override can only narrow what the platform allows. A feature that is
     * switched off for the whole platform can never be switched on again by a
     * single teacher, and a pricing type that is disabled platform-wide stays
     * disabled for every teacher.
     *
     * @return array<string, mixed>
     */
    public function effectiveFor(?int $teacherId): array
    {
        $all = $this->all();

        if ($teacherId === null) {
            return $all;
        }

        $overrides = TeacherSettingOverride::query()
            ->where('teacher_profile_id', $teacherId)
            ->get()
            ->groupBy('group');

        foreach ($overrides as $group => $rows) {
            if (! isset($all[$group]) || ! is_array($all[$group])) {
                continue;
            }

            foreach ($rows as $row) {
                $key = (string) $row->key;
                $value = $row->value;

                if ($group === 'pricing') {
                    // A pricing override names the pricing type and the
                    // values that change for it.
                    foreach ((array) $value as $type => $typeValue) {
                        if (! ($all['pricing'][$type]['enabled'] ?? false)) {
                            continue;
                        }

                        $all['pricing'][$type] = array_merge(
                            $all['pricing'][$type] ?? [],
                            (array) $typeValue
                        );
                    }

                    continue;
                }

                if ($group === 'attendance' && $key === 'verificationEnabled'
                    && ! ($all['attendance']['verificationEnabled'] ?? true)) {
                    continue;
                }

                $all[$group][$key] = $value;
            }
        }

        return $all;
    }

    /**
     * Store the submitted groups without dropping keys the current schema no
     * longer exposes.
     *
     * Replacing a whole group silently deleted legacy keys: an installation
     * that still carried, for example, a "defaultLanguage" or a holiday
     * setting from an earlier schema lost it the first time an administrator
     * saved any other field of that group. The submitted values are therefore
     * merged over the stored group. A key that is not part of the submission
     * keeps its stored value; removing one is a deliberate migration, not a
     * side effect of saving a form.
     *
     * The request itself is still validated against the schema in
     * SettingController, so merge semantics never let a client write a key the
     * server does not understand.
     *
     * @param  array<string, mixed>  $groups
     */
    public function putGroups(array $groups, User $actor): void
    {
        DB::transaction(function () use ($groups, $actor): void {
            foreach ($groups as $key => $value) {
                if (! is_string($key) || ! is_array($value)) {
                    continue;
                }

                $setting = Setting::query()->firstOrNew(['key' => $key]);
                $stored = is_array($setting->value) ? $setting->value : [];

                $setting->fill([
                    'group' => $key,
                    'value' => $this->mergeGroupValues($stored, $value),
                    'type' => 'json',
                    'updated_by' => $actor->id,
                ])->save();
            }
        });
    }

    /**
     * Merge one settings group over the stored one.
     *
     * An associative array is merged recursively so a nested legacy value
     * survives a save that only touches a sibling. A list is replaced, because
     * the order and the membership of a list are part of its meaning.
     *
     * @param  array<mixed>  $stored
     * @param  array<mixed>  $submitted
     * @return array<mixed>
     */
    private function mergeGroupValues(array $stored, array $submitted): array
    {
        foreach ($submitted as $key => $value) {
            if (is_array($value) && ! array_is_list($value)
                && isset($stored[$key]) && is_array($stored[$key]) && ! array_is_list($stored[$key])) {
                $stored[$key] = $this->mergeGroupValues($stored[$key], $value);

                continue;
            }

            $stored[$key] = $value;
        }

        return $stored;
    }

    /**
     * Safe settings for unauthenticated pages and the admin UI.
     *
     * @return array<string, mixed>
     */
    public function publicSettings(): array
    {
        $all = $this->all();
        $attendanceMethod = $all['attendance']['verificationMethod']
            ?? $all['attendance']['method']
            ?? 'teacher-and-student';

        return [
            'general' => [
                'appName' => $all['general']['appName'] ?? 'EduPlatform',
                'supportSignup' => (bool) ($all['general']['supportSignup'] ?? true),
                'teacherSignup' => (bool) ($all['general']['teacherSignup'] ?? true),
                'newBookingsAccepted' => (bool) ($all['general']['newBookingsAccepted'] ?? true),
                'teacherApprovalRequired' => (bool) ($all['general']['teacherApprovalRequired'] ?? false),
                'requireTeacherDocumentVerification' => (bool) ($all['general']['requireTeacherDocumentVerification'] ?? true),
                'maintenanceMode' => (bool) ($all['general']['maintenanceMode'] ?? false),
                'maintenanceNotice' => $all['general']['maintenanceNotice'] ?? 'The platform is temporarily unavailable for maintenance. Please check back shortly.',
                'defaultLanguage' => $all['general']['defaultLanguage'] ?? 'English',
            ],
            'branding' => $all['branding'] ?? [],
            'attendance' => [
                'verificationMethod' => in_array($attendanceMethod, ['teacher-and-student', 'teacher-only'], true)
                    ? $attendanceMethod
                    : 'teacher-and-student',
                'requireReasonWhenLessonMissed' => (bool) ($all['attendance']['requireReasonWhenLessonMissed'] ?? true),
            ],
            'contact' => $all['contact'] ?? [],
            'eligibility' => [
                'configured' => (bool) ($all['eligibility']['configured'] ?? false),
                'type' => $all['eligibility']['type'] ?? 'study-days',
                'minConfirmedDays' => (int) ($all['eligibility']['minConfirmedDays'] ?? 0),
                'minCompletedLessons' => (int) ($all['eligibility']['minCompletedLessons'] ?? 0),
                // Exposed so the client can mirror the server's rule exactly.
                // Without these the review form could not agree with
                // /reviews/eligibility and blocked students the server allowed.
                'requireCompletedBooking' => (bool) ($all['eligibility']['requireCompletedBooking'] ?? true),
            ],
            'pricing' => $all['pricing'] ?? [],
            'otp' => [
                'enabled' => (bool) ($all['otp']['enabled'] ?? true),
                'requireRegistrationOtp' => (bool) ($all['otp']['requireRegistrationOtp'] ?? false),
                'requirePasswordResetOtp' => (bool) ($all['otp']['requirePasswordResetOtp'] ?? true),
                'channel' => (string) ($all['otp']['channel'] ?? 'whatsapp'),
                'otpExpiryMinutes' => (int) ($all['otp']['otpExpiryMinutes'] ?? 10),
                'otpMaxAttempts' => (int) ($all['otp']['otpMaxAttempts'] ?? 5),
            ],
        ];
    }

    public function notificationEnabled(string $category): bool
    {
        $notifications = $this->get('notifications', []);

        return (bool) ($notifications['enabled'][$category] ?? true);
    }
}
