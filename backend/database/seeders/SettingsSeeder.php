<?php

namespace Database\Seeders;

use App\Models\Setting;
use Illuminate\Database\Seeder;

class SettingsSeeder extends Seeder
{
    public function run(): void
    {
        $defaults = [
            'general' => [
                'appName' => 'EduPlatform',
                'supportSignup' => true,
                'teacherSignup' => true,
                'newBookingsAccepted' => true,
                'teacherApprovalRequired' => false,
                'requireTeacherDocumentVerification' => true,
                'maintenanceMode' => false,
                'maintenanceNotice' => 'The platform is temporarily unavailable for maintenance. Please check back shortly.',
            ],
            'attendance' => [
                // Which confirmation the platform requires before a lesson
                // counts as verified. Only methods the backend can actually
                // enforce are offered — an OTP method is deliberately absent
                // because no OTP-backed attendance flow exists.
                //   teacher-and-student : the teacher marks it, the student confirms (default)
                //   teacher-only        : the teacher's mark is final
                'verificationEnabled' => true,
                'verificationMethod' => 'teacher-and-student',
                'requireReasonWhenLessonMissed' => true,
            ],
            'whatsapp' => [
                'enabled' => false,
                'provider' => 'meta-cloud-api',
                'phoneNumberId' => '',
                'businessAccountId' => '',
                'testRecipient' => '',
                'otpExpiryMinutes' => 10,
                'otpMaxAttempts' => 5,
                'credentialSource' => 'server-environment',
                'lastTestStatus' => 'not-configured',
            ],
            'otp' => [
                'enabled' => true,
                'requireRegistrationOtp' => false,
                'requirePasswordResetOtp' => true,
                'channel' => 'whatsapp',
                'otpExpiryMinutes' => 10,
                'otpMaxAttempts' => 5,
            ],
            'holidays' => [
                'blockNewBookings' => true,
            ],
            'eligibility' => [
                'configured' => false,
                'type' => 'study-days',
                'minConfirmedDays' => 0,
                'minCompletedLessons' => 0,
                'requireCompletedBooking' => true,
            ],
            'pricing' => [
                'hourly' => ['enabled' => true, 'mode' => 'optional'],
                'monthly' => ['enabled' => false, 'mode' => 'optional'],
                'course' => ['enabled' => false, 'mode' => 'optional'],
            ],
            'terms' => [
                'common' => null,
                'student' => null,
                'teacher' => null,
            ],
            'contact' => [
                'enabled' => true,
                'title' => 'Contact & support',
                'message' => '',
                'email' => '',
                'phone' => '',
                'whatsapp' => '',
                'hours' => '',
                'showEmail' => true,
                'showPhone' => true,
                'showWhatsapp' => true,
            ],
            'branding' => [
                'appName' => 'EduPlatform',
                'tagline' => '',
                'logo' => null,
                'logo2' => null,
                'favicon' => null,
            ],
            'notifications' => [
                'enabled' => [
                    'attendance-reminder' => true,
                    'dispute-opened' => true,
                    'dispute-resolved' => true,
                    'booking-update' => true,
                    'review-update' => true,
                    'system' => true,
                ],
                'reminderDelayHours' => 6,
                'reminderIntervalHours' => 24,
                'maxReminderAttempts' => 3,
                'notifyAdminsOnDispute' => true,
                'notifyPartiesOnResolution' => true,
            ],
            'backups' => [
                'root' => 'internal',
                'directory' => '',
                'retainDays' => 14,
                'scheduleEnabled' => true,
                'scheduleTime' => '02:00',
            ],
        ];

        foreach ($defaults as $group => $value) {
            Setting::updateOrCreate(
                ['key' => $group],
                ['group' => $group, 'value' => $value, 'type' => 'json']
            );
        }
    }
}
