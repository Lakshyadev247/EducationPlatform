<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\AttendanceRecord;
use App\Models\Booking;
use App\Models\Notification;
use App\Models\Review;
use App\Models\Role;
use App\Models\StudentProfile;
use App\Models\TeacherProfile;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class DashboardController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        $user = $request->user();
        $unread = Notification::query()->where('user_id', $user->id)->whereNull('read_at')->count();

        if ($user->hasRole(Role::STUDENT)) {
            $profile = $user->studentProfile;
            $bookings = Booking::query()->where('student_id', $user->id);
            $attendance = AttendanceRecord::query()->where('student_id', $user->id);

            return response()->json(['data' => [
                'role' => Role::STUDENT,
                'profile_completed' => $profile?->completed_at !== null,
                'unread_notifications' => $unread,
                'bookings' => [
                    'total' => (clone $bookings)->count(),
                    'pending' => (clone $bookings)->where('status', 'pending')->count(),
                    'accepted' => (clone $bookings)->where('status', 'accepted')->count(),
                    'completed' => (clone $bookings)->where('status', 'completed')->count(),
                ],
                'attendance' => [
                    'total' => (clone $attendance)->count(),
                    'pending' => (clone $attendance)->where('confirmation', 'pending')->count(),
                    'confirmed' => (clone $attendance)->where('confirmation', 'confirmed')->count(),
                    'disputed' => (clone $attendance)->where('confirmation', 'disputed')->count(),
                ],
                'reviews_written' => Review::query()->where('student_id', $user->id)->count(),
            ]]);
        }

        if ($user->hasRole(Role::TEACHER)) {
            $profile = $user->teacherProfile()->withCount('reviews')->first();
            $bookings = Booking::query()->where('teacher_id', $user->id);
            $attendance = AttendanceRecord::query()->where('teacher_id', $user->id);
            $attendanceTodo = (clone $bookings)
                ->whereIn('status', [Booking::STATUS_ACCEPTED, Booking::STATUS_COMPLETED])
                ->whereDoesntHave('attendance')
                ->whereDate('booking_date', '<=', now('Asia/Kolkata')->toDateString())
                ->count();

            return response()->json(['data' => [
                'role' => Role::TEACHER,
                'profile_completed' => $profile?->completed_at !== null,
                'approval_status' => $profile?->approval_status,
                'is_public' => (bool) $profile?->is_public,
                'unread_notifications' => $unread,
                'bookings' => [
                    'total' => (clone $bookings)->count(),
                    'pending_requests' => (clone $bookings)->where('status', 'pending')->count(),
                    'accepted' => (clone $bookings)->where('status', 'accepted')->count(),
                    'completed' => (clone $bookings)->where('status', 'completed')->count(),
                ],
                'attendance' => [
                    'total' => (clone $attendance)->count(),
                    'pending_confirmation' => (clone $attendance)->where('confirmation', 'pending')->count(),
                    'disputed' => (clone $attendance)->where('confirmation', 'disputed')->count(),
                    'marking_todo' => $attendanceTodo,
                ],
                'reviews_received' => Review::query()->where('teacher_id', $user->id)->where('status', 'published')->count(),
                'rating_average' => Review::query()->where('teacher_id', $user->id)->where('status', 'published')->avg('rating'),
            ]]);
        }

        abort_unless($user->isAdmin(), 403);

        return response()->json(['data' => [
            'role' => $user->isSuperAdmin() ? Role::SUPER_ADMIN : Role::ADMIN,
            'users' => [
                'students' => User::query()->whereHas('roles', fn ($q) => $q->where('name', Role::STUDENT))->count(),
                'teachers' => User::query()->whereHas('roles', fn ($q) => $q->where('name', Role::TEACHER))->count(),
                'admins' => User::query()->whereHas('roles', fn ($q) => $q->whereIn('name', [Role::ADMIN, Role::SUPER_ADMIN]))->count(),
                'suspended' => User::query()->where('status', 'suspended')->count(),
            ],
            'teacher_approvals_pending' => TeacherProfile::query()->where('approval_status', 'pending')->count(),
            'open_attendance_cases' => AttendanceRecord::query()
                ->where(fn ($q) => $q->where('confirmation', 'disputed')->orWhereHas('corrections', fn ($c) => $c->where('status', 'pending')))
                ->count(),
            'reviews' => [
                'published' => Review::query()->where('status', 'published')->count(),
                'flagged' => Review::query()->where('status', 'flagged')->count(),
                'hidden' => Review::query()->where('status', 'hidden')->count(),
            ],
            'student_profiles_completed' => StudentProfile::query()->whereNotNull('completed_at')->count(),
            'unread_notifications' => $unread,
        ]]);
    }
}
