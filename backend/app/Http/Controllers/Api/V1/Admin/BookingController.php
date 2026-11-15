<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\BookingResource;
use App\Models\Booking;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The bookings an administrator can see and manage.
 *
 * An administrator can review requests, discuss custom pricing and scheduling
 * with the student on call, approve & assign bookings to teachers, and manage agreed rates.
 */
class BookingController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'status' => ['nullable', Rule::in(['pending', 'accepted', 'rejected', 'cancelled', 'completed'])],
            'booking_type' => ['nullable', Rule::in(['demo', 'monthly', 'course'])],
            'teacher_id' => ['nullable', 'integer', 'exists:users,id'],
            'student_id' => ['nullable', 'integer', 'exists:users,id'],
            'q' => ['nullable', 'string', 'max:120'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $query = Booking::query()
            ->with(['student:id,name,phone,email', 'teacher:id,name,phone,email', 'subject:id,name', 'attendance', 'review', 'approvedBy:id,name'])
            ->orderByDesc('booking_date')
            ->orderByDesc('start_time');

        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (! empty($filters['booking_type'])) {
            $query->where('booking_type', $filters['booking_type']);
        }

        if (! empty($filters['q'])) {
            // The search runs over the fields the list already shows: the
            // reference, the student, the teacher and the subject.
            $term = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], trim($filters['q'])).'%';

            $query->where(function ($inner) use ($term): void {
                $inner->where('reference', 'like', $term)
                    ->orWhereHas('student', fn ($s) => $s->where('name', 'like', $term)->orWhere('email', 'like', $term)->orWhere('phone', 'like', $term))
                    ->orWhereHas('teacher', fn ($t) => $t->where('name', 'like', $term)->orWhere('email', 'like', $term)->orWhere('phone', 'like', $term))
                    ->orWhereHas('subject', fn ($s) => $s->where('name', 'like', $term));
            });
        }
        if (! empty($filters['teacher_id'])) {
            $query->where('teacher_id', $filters['teacher_id']);
        }
        if (! empty($filters['student_id'])) {
            $query->where('student_id', $filters['student_id']);
        }

        $bookings = $query->paginate((int) ($filters['per_page'] ?? 25))->withQueryString();

        return BookingResource::collection($bookings)->response();
    }

    public function approve(Request $request, Booking $booking, AuditLogger $auditLogger, NotificationService $notifications): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $booking->ensureCanTransitionTo(Booking::STATUS_ACCEPTED);

        $wasPending = $booking->status === Booking::STATUS_PENDING;

        $data = $request->validate([
            'agreed_price' => ['nullable', 'numeric', 'min:0', 'max:999999.99'],
            'pricing_type' => ['nullable', 'string', 'in:hourly,monthly,course,custom'],
            'admin_notes' => ['nullable', 'string', 'max:500'],
        ]);

        $booking->forceFill([
            'status' => Booking::STATUS_ACCEPTED,
            'agreed_price' => $data['agreed_price'] ?? $booking->agreed_price,
            'pricing_type' => $data['pricing_type'] ?? ($booking->pricing_type ?? $booking->booking_type),
            'admin_notes' => $data['admin_notes'] ?? $booking->admin_notes,
            'approved_by' => $request->user()->id,
            'approved_at' => now(),
            'decided_at' => now(),
        ])->save();

        $planLabel = match ($booking->booking_type) {
            'monthly' => 'Monthly regular tuition',
            'course' => 'Full course tuition',
            default => 'Lesson',
        };

        $teacher = $booking->teacher;
        $student = $booking->student;

        if ($teacher !== null) {
            $studentContact = $student?->phone ? " (Student phone: {$student->phone})" : '';
            $notifications->send(
                $teacher,
                'booking-update',
                'Admin approved & assigned student',
                "Admin confirmed {$student?->name} for {$booking->subject?->name} ({$planLabel}) starting {$booking->booking_date->format('d M Y')}{$studentContact}.",
                'booking',
                $booking->id,
                'admin-booking-approved-teacher:'.$booking->id
            );
        }

        if ($student !== null) {
            $feeNotice = $booking->agreed_price !== null ? " Agreed fee: ₹{$booking->agreed_price}." : '';
            $notifications->send(
                $student,
                'booking-update',
                'Your tuition request is confirmed!',
                "Your {$booking->subject?->name} request with {$teacher?->name} has been approved by admin.{$feeNotice}",
                'booking',
                $booking->id,
                'admin-booking-approved-student:'.$booking->id
            );
        }

        $auditLogger->record(
            $request->user(),
            'booking.admin_approved',
            'booking',
            $booking->id,
            ['status' => $wasPending ? 'pending' : 'accepted'],
            ['status' => 'accepted', 'agreed_price' => $booking->agreed_price, 'pricing_type' => $booking->pricing_type],
            $booking->admin_notes
        );

        return (new BookingResource($booking->fresh([
            'student:id,name,phone,email', 'teacher:id,name,phone,email', 'subject:id,name', 'attendance', 'review', 'approvedBy:id,name',
        ])))->response();
    }

    public function updatePricing(Request $request, Booking $booking, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'agreed_price' => ['nullable', 'numeric', 'min:0', 'max:999999.99'],
            'pricing_type' => ['nullable', 'string', 'in:hourly,monthly,course,custom'],
            'admin_notes' => ['nullable', 'string', 'max:500'],
        ]);

        $booking->forceFill([
            'agreed_price' => array_key_exists('agreed_price', $data) ? $data['agreed_price'] : $booking->agreed_price,
            'pricing_type' => array_key_exists('pricing_type', $data) ? $data['pricing_type'] : $booking->pricing_type,
            'admin_notes' => array_key_exists('admin_notes', $data) ? $data['admin_notes'] : $booking->admin_notes,
        ])->save();

        $auditLogger->record(
            $request->user(),
            'booking.pricing_updated',
            'booking',
            $booking->id,
            [],
            ['agreed_price' => $booking->agreed_price, 'pricing_type' => $booking->pricing_type],
            $booking->admin_notes
        );

        return (new BookingResource($booking->fresh([
            'student:id,name,phone,email', 'teacher:id,name,phone,email', 'subject:id,name', 'attendance', 'review', 'approvedBy:id,name',
        ])))->response();
    }
}
