<?php

namespace App\Services;

/**
 * The settings an administrator may change, and the values each one accepts.
 *
 * Anything that is not listed here is rejected by the settings endpoint. A
 * stored value therefore always has a meaning behind it, and a control that
 * the server does not read can no longer be presented as if it did something.
 *
 * Keys that used to live here and no longer have a purpose (the fixed
 * attendance rules, the removed attendance-OTP options, the review limits
 * that are now a fixed rule, the language that does not exist yet) are simply
 * absent. Rows that still hold them in an older database are ignored.
 */
class SettingSchema
{
    /**
     * Groups that another endpoint owns. They can be read, but they are not
     * edited through the settings endpoint: the terms documents are versioned
     * by the terms endpoint, and the holiday rows live in their own table.
     *
     * @var list<string>
     */
    private const READ_ONLY_GROUPS = ['terms'];

    /**
     * @return array<string, array<string, array<string, mixed>>>
     */
    public function groups(): array
    {
        return [
            'general' => [
                'appName' => ['type' => 'string', 'min' => 2, 'max' => 120],
                'supportSignup' => ['type' => 'bool'],
                'teacherSignup' => ['type' => 'bool'],
                'newBookingsAccepted' => ['type' => 'bool'],
                'teacherApprovalRequired' => ['type' => 'bool'],
                'requireTeacherDocumentVerification' => ['type' => 'bool'],
                'maintenanceMode' => ['type' => 'bool'],
                'maintenanceNotice' => ['type' => 'string', 'max' => 240],
            ],
            'attendance' => [
                // When this is off, attendance cannot be recorded at all.
                'verificationEnabled' => ['type' => 'bool'],
                'verificationMethod' => ['type' => 'enum', 'values' => ['teacher-and-student', 'teacher-only']],
                'requireReasonWhenLessonMissed' => ['type' => 'bool'],
            ],
            'whatsapp' => [
                'enabled' => ['type' => 'bool'],
                'provider' => ['type' => 'string', 'max' => 60],
                'phoneNumberId' => ['type' => 'string', 'max' => 64],
                'businessAccountId' => ['type' => 'string', 'max' => 64],
                'testRecipient' => ['type' => 'string', 'max' => 32],
                'otpExpiryMinutes' => ['type' => 'int', 'min' => 1, 'max' => 60],
                'otpMaxAttempts' => ['type' => 'int', 'min' => 1, 'max' => 10],
                'credentialSource' => ['type' => 'string', 'max' => 40],
                'lastTestStatus' => ['type' => 'enum', 'values' => ['not-configured', 'sent', 'not-delivered', 'failed']],
            ],
            'otp' => [
                'enabled' => ['type' => 'bool'],
                'requireRegistrationOtp' => ['type' => 'bool'],
                'requirePasswordResetOtp' => ['type' => 'bool'],
                'channel' => ['type' => 'string', 'max' => 30],
                'otpExpiryMinutes' => ['type' => 'int', 'min' => 1, 'max' => 60],
                'otpMaxAttempts' => ['type' => 'int', 'min' => 1, 'max' => 10],
            ],
            'holidays' => [
                // The holiday rows themselves are owned by the holidays
                // endpoint, not by the settings endpoint.
                'blockNewBookings' => ['type' => 'bool'],
            ],
            'eligibility' => [
                'configured' => ['type' => 'bool'],
                'type' => ['type' => 'enum', 'values' => ['study-days', 'completed-lessons']],
                'minConfirmedDays' => ['type' => 'int', 'min' => 0, 'max' => 99],
                'minCompletedLessons' => ['type' => 'int', 'min' => 0, 'max' => 99],
                'requireCompletedBooking' => ['type' => 'bool'],
            ],
            'pricing' => [
                'hourly' => ['type' => 'pricing'],
                'monthly' => ['type' => 'pricing'],
                'course' => ['type' => 'pricing'],
            ],
            'contact' => [
                'enabled' => ['type' => 'bool'],
                'title' => ['type' => 'string', 'max' => 120],
                'message' => ['type' => 'string', 'max' => 1000],
                'email' => ['type' => 'nullable_email'],
                'phone' => ['type' => 'string', 'max' => 32],
                'whatsapp' => ['type' => 'string', 'max' => 32],
                'hours' => ['type' => 'string', 'max' => 120],
                'showEmail' => ['type' => 'bool'],
                'showPhone' => ['type' => 'bool'],
                'showWhatsapp' => ['type' => 'bool'],
            ],
            'branding' => [
                'appName' => ['type' => 'string', 'max' => 120],
                'tagline' => ['type' => 'string', 'max' => 160],
                'logo' => ['type' => 'nullable_storage_url'],
                'logo2' => ['type' => 'nullable_storage_url'],
                'favicon' => ['type' => 'nullable_storage_url'],
            ],
            'notifications' => [
                'enabled' => ['type' => 'bool_map'],
                'reminderDelayHours' => ['type' => 'int', 'min' => 0, 'max' => 168],
                'reminderIntervalHours' => ['type' => 'int', 'min' => 1, 'max' => 720],
                'maxReminderAttempts' => ['type' => 'int', 'min' => 0, 'max' => 20],
                'notifyAdminsOnDispute' => ['type' => 'bool'],
                'notifyPartiesOnResolution' => ['type' => 'bool'],
            ],
            'backups' => [
                // The destination is a folder inside one of the backup
                // locations the server owner authorised. The database
                // connection itself stays in .env; this group only controls
                // where copies are written.
                'root' => ['type' => 'string', 'max' => 60],
                'directory' => ['type' => 'backup_path', 'max' => 255],
                'retainDays' => ['type' => 'int', 'min' => 1, 'max' => 365],
                'scheduleEnabled' => ['type' => 'bool'],
                'scheduleTime' => ['type' => 'time'],
            ],
        ];
    }

    /**
     * The keys of a group whose value is plain text.
     *
     * These keys are never null: an administrator who leaves a text field
     * empty means "empty", which is different from a value that is not set.
     *
     * @return list<string>
     */
    public function textKeys(string $group): array
    {
        $keys = [];

        foreach ($this->groups()[$group] ?? [] as $key => $definition) {
            if (in_array(($definition['type'] ?? ''), ['string', 'backup_path'], true)) {
                $keys[] = $key;
            }
        }

        return $keys;
    }

    /**
     * @return list<string>
     */
    public function groupNames(): array
    {
        return array_merge(array_keys($this->groups()), self::READ_ONLY_GROUPS);
    }

    public function isReadOnly(string $group): bool
    {
        return in_array($group, self::READ_ONLY_GROUPS, true);
    }

    /**
     * The keys of a group that are not part of the schema.
     *
     * @param  array<string, mixed>  $values
     * @return list<string>
     */
    public function unknownKeys(string $group, array $values): array
    {
        $known = array_keys($this->groups()[$group] ?? []);

        return array_values(array_filter(
            array_keys($values),
            static fn (string $key): bool => ! in_array($key, $known, true)
        ));
    }

    /**
     * The validation rules for one group, keyed by the full input path.
     *
     * @return array<string, list<string>>
     */
    public function rulesFor(string $group): array
    {
        $rules = [];

        foreach ($this->groups()[$group] ?? [] as $key => $definition) {
            $path = 'settings.'.$group.'.'.$key;
            $type = (string) ($definition['type'] ?? 'string');

            if ($type === 'bool') {
                $rules[$path] = ['boolean'];
            } elseif ($type === 'int') {
                $rules[$path] = [
                    'integer',
                    'min:'.($definition['min'] ?? 0),
                    'max:'.($definition['max'] ?? 100000),
                ];
            } elseif ($type === 'enum') {
                $rules[$path] = ['string', 'in:'.implode(',', $definition['values'] ?? [])];
            } elseif ($type === 'nullable_email') {
                $rules[$path] = ['nullable', 'string', 'email', 'max:190'];
            } elseif ($type === 'bool_map' || $type === 'pricing') {
                $rules[$path] = ['array'];
            } elseif ($type === 'nullable_storage_url') {
                $rules[$path] = ['nullable', 'string', 'max:255'];
            } elseif ($type === 'time') {
                $rules[$path] = ['string', 'date_format:H:i'];
            } elseif ($type === 'backup_path') {
                $rules[$path] = ['string', 'max:'.($definition['max'] ?? 120)];
            } else {
                $rules[$path] = [
                    'string',
                    'max:'.($definition['max'] ?? 255),
                    'min:'.($definition['min'] ?? 0),
                ];
            }
        }

        if (($this->groups()[$group]['enabled']['type'] ?? null) === 'bool_map') {
            $rules['settings.'.$group.'.enabled.*'] = ['boolean'];
        }

        if (($this->groups()[$group]['hourly']['type'] ?? null) === 'pricing') {
            foreach (['hourly', 'monthly', 'course'] as $type) {
                $rules['settings.'.$group.'.'.$type.'.enabled'] = ['boolean'];
                $rules['settings.'.$group.'.'.$type.'.mode'] = ['string', 'in:optional,required'];
            }
        }

        return $rules;
    }
}
