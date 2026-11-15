<?php

use App\Http\Controllers\Api\V1\Admin\AccountClosureController;
use App\Http\Controllers\Api\V1\Admin\AttendanceController as AdminAttendanceController;
use App\Http\Controllers\Api\V1\Admin\AuditLogController;
use App\Http\Controllers\Api\V1\Admin\BookingController as AdminBookingController;
use App\Http\Controllers\Api\V1\Admin\BrandingController;
use App\Http\Controllers\Api\V1\Admin\DataController;
use App\Http\Controllers\Api\V1\Admin\DirectoryController;
use App\Http\Controllers\Api\V1\Admin\HolidayController;
use App\Http\Controllers\Api\V1\Admin\ReminderController;
use App\Http\Controllers\Api\V1\Admin\ReviewController as AdminReviewController;
use App\Http\Controllers\Api\V1\Admin\RoleController;
use App\Http\Controllers\Api\V1\Admin\SettingController;
use App\Http\Controllers\Api\V1\Admin\StorageController;
use App\Http\Controllers\Api\V1\Admin\TeacherController as AdminTeacherController;
use App\Http\Controllers\Api\V1\Admin\TermsController;
use App\Http\Controllers\Api\V1\Admin\UserController;
use App\Http\Controllers\Api\V1\Admin\WhatsappController;
use App\Http\Controllers\Api\V1\AttendanceController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\BookingController;
use App\Http\Controllers\Api\V1\DashboardController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\MetadataController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\ReportController;
use App\Http\Controllers\Api\V1\ReviewController;
use App\Http\Controllers\Api\V1\StudentProfileController;
use App\Http\Controllers\Api\V1\TeacherDirectoryController;
use App\Http\Controllers\Api\V1\TeacherProfileController;
use App\Http\Middleware\EnsureAccountIsActive;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function (): void {
    Route::get('/health', HealthController::class)->name('api.health');
    Route::get('/meta', [MetadataController::class, 'index'])->name('api.meta');

    Route::get('/teachers', [TeacherDirectoryController::class, 'index'])->name('api.teachers.index');
    Route::get('/teachers/{teacher}', [TeacherDirectoryController::class, 'show'])
        ->whereNumber('teacher')
        ->name('api.teachers.show');
    Route::get('/teachers/{teacher}/reviews', [TeacherDirectoryController::class, 'reviews'])
        ->whereNumber('teacher')
        ->name('api.teachers.reviews');

    Route::get('/storage/documents/{document}/download', [StorageController::class, 'downloadDocument'])
        ->name('api.storage.documents.download.signed');

    // Every authenticated API route checks that the account is still active.
    // A session issued before a suspension must not keep working.
    Route::middleware(['auth:sanctum', EnsureAccountIsActive::class])->group(function (): void {
        Route::get('/me', [AuthController::class, 'me'])->name('api.me');
        Route::get('/dashboard', [DashboardController::class, 'show'])->name('api.dashboard');

        Route::get('/notifications', [NotificationController::class, 'index'])->name('api.notifications.index');
        Route::get('/notifications/unread-count', [NotificationController::class, 'unreadCount'])->name('api.notifications.unread');
        Route::patch('/notifications/{notification}/read', [NotificationController::class, 'markRead'])->name('api.notifications.read');
        Route::post('/notifications/read-all', [NotificationController::class, 'markAllRead'])->name('api.notifications.read-all');

        Route::middleware('role:student')->group(function (): void {
            Route::get('/student/profile', [StudentProfileController::class, 'show'])->name('api.student.profile.show');
            Route::put('/student/profile', [StudentProfileController::class, 'update'])->name('api.student.profile.update');
            Route::post('/student/photo', [StudentProfileController::class, 'photo'])->name('api.student.photo');
            Route::get('/student/address', [StudentProfileController::class, 'showAddress'])->name('api.student.address.show');
            Route::put('/student/address', [StudentProfileController::class, 'updateAddress'])->name('api.student.address.update');

            Route::post('/bookings', [BookingController::class, 'store'])->name('api.bookings.store');
            Route::get('/reviews/eligibility', [ReviewController::class, 'eligibility'])->name('api.reviews.eligibility');
            Route::post('/reviews', [ReviewController::class, 'store'])->name('api.reviews.store');
        });

        Route::middleware('role:teacher')->group(function (): void {
            Route::get('/teacher/profile', [TeacherProfileController::class, 'show'])->name('api.teacher.profile.show');
            Route::patch('/teacher/profile', [TeacherProfileController::class, 'update'])->name('api.teacher.profile.update');
            Route::post('/teacher/photo', [TeacherProfileController::class, 'photo'])->name('api.teacher.photo');
            Route::put('/teacher/prices', [TeacherProfileController::class, 'updatePrices'])->name('api.teacher.prices');
            Route::get('/teacher/documents', [TeacherProfileController::class, 'documents'])->name('api.teacher.documents.show');
            Route::post('/teacher/documents', [TeacherProfileController::class, 'uploadDocuments'])->name('api.teacher.documents.upload');
        });

        Route::get('/bookings', [BookingController::class, 'index'])->name('api.bookings.index');
        Route::get('/bookings/{booking}', [BookingController::class, 'show'])->name('api.bookings.show');
        Route::patch('/bookings/{booking}/cancel', [BookingController::class, 'cancel'])->name('api.bookings.cancel');

        Route::middleware('role:teacher')->group(function (): void {
            Route::patch('/bookings/{booking}/accept', [BookingController::class, 'accept'])->name('api.bookings.accept');
            Route::patch('/bookings/{booking}/reject', [BookingController::class, 'reject'])->name('api.bookings.reject');
            Route::patch('/bookings/{booking}/complete', [BookingController::class, 'complete'])->name('api.bookings.complete');
        });

        Route::get('/attendance', [AttendanceController::class, 'index'])->name('api.attendance.index');
        Route::get('/attendance/{attendance}', [AttendanceController::class, 'show'])->name('api.attendance.show');
        Route::post('/attendance', [AttendanceController::class, 'store'])->name('api.attendance.store');
        Route::patch('/attendance/{attendance}/confirm', [AttendanceController::class, 'confirm'])->name('api.attendance.confirm');
        Route::patch('/attendance/{attendance}/dispute', [AttendanceController::class, 'dispute'])->name('api.attendance.dispute');
        Route::post('/attendance/{attendance}/corrections', [AttendanceController::class, 'requestCorrection'])->name('api.attendance.corrections');

        Route::get('/reviews', [ReviewController::class, 'index'])->name('api.reviews.index');
        Route::patch('/reviews/{review}', [ReviewController::class, 'update'])->name('api.reviews.update');
        Route::delete('/reviews/{review}', [ReviewController::class, 'destroy'])->name('api.reviews.destroy');

        Route::get('/reports/attendance.csv', [ReportController::class, 'attendanceCsv'])->name('api.reports.attendance.csv');
        Route::get('/reports/bookings.csv', [ReportController::class, 'bookingsCsv'])->name('api.reports.bookings.csv');

        Route::middleware(['role:admin,super_admin'])
            ->prefix('admin')
            ->name('api.admin.')
            ->group(function (): void {
                Route::get('/roles', [RoleController::class, 'index'])->name('roles.index');
                Route::get('/health', [HealthController::class, 'detailed'])->name('health');
                Route::get('/users', [UserController::class, 'index'])->name('users.index');
                Route::post('/users', [UserController::class, 'store'])->name('users.store');
                Route::patch('/users/{user}/role', [UserController::class, 'updateRole'])->name('users.role.update');

                Route::get('/directory/users', [DirectoryController::class, 'users'])->name('directory.users');
                Route::get('/directory/users/{user}', [DirectoryController::class, 'show'])->withTrashed()->name('directory.users.show');
                Route::patch('/users/{user}/status', [DirectoryController::class, 'updateStatus'])->name('users.status');
                // Closing keeps the operational history and anonymises the
                // account. withTrashed() makes a repeated request safe.
                Route::delete('/users/{user}/account', [AccountClosureController::class, 'destroy'])
                    ->withTrashed()
                    ->name('users.account.close');

                Route::get('/bookings', [AdminBookingController::class, 'index'])->name('bookings.index');
                Route::patch('/bookings/{booking}/approve', [AdminBookingController::class, 'approve'])->name('bookings.approve');
                Route::patch('/bookings/{booking}/pricing', [AdminBookingController::class, 'updatePricing'])->name('bookings.pricing');
                Route::get('/teachers', [AdminTeacherController::class, 'index'])->name('teachers.index');
                Route::patch('/teachers/{user}/approval', [AdminTeacherController::class, 'approve'])->name('teachers.approval');
                Route::get('/teachers/{user}/documents', [AdminTeacherController::class, 'documents'])->name('teachers.documents.show');
                Route::post('/teachers/{user}/verify-documents', [AdminTeacherController::class, 'verifyDocuments'])->name('teachers.documents.verify');
                Route::get('/teachers/{user}/unavailable-dates', [AdminTeacherController::class, 'unavailableDates'])->name('teachers.unavailable_dates.index');
                Route::post('/teachers/{user}/unavailable-dates', [AdminTeacherController::class, 'addUnavailableDate'])->name('teachers.unavailable_dates.store');
                Route::delete('/teachers/{user}/unavailable-dates/{date}', [AdminTeacherController::class, 'removeUnavailableDate'])->name('teachers.unavailable_dates.destroy');
                Route::get('/teachers/{user}/overrides', [AdminTeacherController::class, 'overrides'])->name('teachers.overrides.index');
                Route::put('/teachers/{user}/overrides', [AdminTeacherController::class, 'setOverride'])->name('teachers.overrides.update');

                Route::get('/attendance', [AdminAttendanceController::class, 'index'])->name('attendance.index');
                Route::post('/attendance/{attendance}/decisions', [AdminAttendanceController::class, 'decide'])->name('attendance.decisions');

                Route::get('/reviews', [AdminReviewController::class, 'index'])->name('reviews.index');
                Route::patch('/reviews/{review}/moderation', [AdminReviewController::class, 'moderate'])->name('reviews.moderate');

                Route::get('/settings', [SettingController::class, 'index'])->name('settings.index');
                Route::put('/settings', [SettingController::class, 'update'])->name('settings.update');

                Route::get('/audit-logs', [AuditLogController::class, 'index'])->name('audit.index');
                Route::delete('/audit-logs', [AuditLogController::class, 'clear'])->name('audit.clear');
                Route::get('/holidays', [HolidayController::class, 'index'])->name('holidays.index');
                Route::post('/holidays', [HolidayController::class, 'store'])->name('holidays.store');
                Route::delete('/holidays/{holiday}', [HolidayController::class, 'destroy'])->name('holidays.destroy');

                Route::post('/reminders/run', [ReminderController::class, 'run'])->name('reminders.run');

                Route::get('/whatsapp/status', [WhatsappController::class, 'status'])->name('whatsapp.status');
                Route::post('/whatsapp/test', [WhatsappController::class, 'testSend'])
                    ->middleware('throttle:whatsapp-test')
                    ->name('whatsapp.test');

                Route::post('/branding/upload', [BrandingController::class, 'upload'])->name('branding.upload');
                Route::post('/branding/reset', [BrandingController::class, 'reset'])->name('branding.reset');

                Route::get('/terms', [TermsController::class, 'index'])->name('terms.index');
                Route::post('/terms', [TermsController::class, 'publish'])->name('terms.publish');
                Route::delete('/terms/{audience}', [TermsController::class, 'destroy'])->name('terms.destroy');

                Route::prefix('storage')->name('storage.')->group(function (): void {
                    Route::get('/dashboard', [StorageController::class, 'dashboard'])->name('dashboard');
                    Route::get('/providers', [StorageController::class, 'providers'])->name('providers.index');
                    Route::get('/providers/{key}', [StorageController::class, 'showProvider'])->name('providers.show');
                    Route::put('/providers/{key}', [StorageController::class, 'updateProvider'])->name('providers.update');
                    Route::post('/providers/{key}/test', [StorageController::class, 'testConnection'])->name('providers.test');
                    Route::post('/providers/{key}/activate', [StorageController::class, 'activate'])->name('providers.activate');
                    Route::post('/providers/{key}/disconnect', [StorageController::class, 'disconnect'])->name('providers.disconnect');

                    Route::get('/documents', [StorageController::class, 'documents'])->name('documents.index');
                    Route::post('/documents', [StorageController::class, 'uploadDocument'])->name('documents.upload');
                    Route::get('/documents/{document}/download', [StorageController::class, 'downloadDocument'])->name('documents.download');
                    Route::get('/documents/{document}/signed-url', [StorageController::class, 'signedUrl'])->name('documents.signed_url');
                    Route::delete('/documents/{document}', [StorageController::class, 'deleteDocument'])->name('documents.destroy');

                    Route::get('/logs', [StorageController::class, 'logs'])->name('logs.index');
                });

                // The whole data panel is Super Admin only; the controller
                // checks the role again so a regular admin cannot reach it.
                Route::prefix('data')->name('data.')->group(function (): void {
                    Route::get('/', [DataController::class, 'overview'])->name('overview');
                    Route::get('/folders', [DataController::class, 'folders'])->name('folders.index');
                    Route::post('/folders', [DataController::class, 'createFolder'])
                        ->middleware('throttle:12,1')
                        ->name('folders.store');
                    Route::get('/tables/{table}', [DataController::class, 'rows'])->name('tables.rows');
                    Route::post('/backups', [DataController::class, 'backup'])
                        ->middleware('throttle:backup-create')
                        ->name('backups.store');
                    Route::post('/backups/download', [DataController::class, 'downloadBackup'])
                        ->middleware('throttle:backup-download')
                        ->name('backups.download');
                    Route::get('/backups/{file}', [DataController::class, 'download'])->name('backups.download.file');
                    Route::delete('/backups/{file}', [DataController::class, 'destroy'])->name('backups.destroy');
                    Route::post('/restore/token', [DataController::class, 'restoreToken'])
                        ->middleware('throttle:backup-restore-token')
                        ->name('restore.token');
                    Route::post('/restore', [DataController::class, 'restore'])
                        ->middleware('throttle:backup-restore')
                        ->name('restore');
                });
            });
    });
});
