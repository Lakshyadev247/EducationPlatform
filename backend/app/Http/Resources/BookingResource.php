<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class BookingResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $booking = $this->resource;
        $attendance = $booking->relationLoaded('attendance') ? $booking->attendance : null;
        $review = $booking->relationLoaded('review') ? $booking->review : null;

        return [
            'id' => $booking->id,
            'reference' => $booking->reference,
            'student_id' => $booking->student_id,
            'student_name' => $booking->student?->name,
            'teacher_id' => $booking->teacher_id,
            'teacher_name' => $booking->teacher?->name,
            'subject_id' => $booking->subject_id,
            'subject' => $booking->subject?->name,
            'date' => $booking->booking_date?->toDateString(),
            'start_time' => substr((string) $booking->start_time, 0, 5),
            'end_time' => $booking->end_time === null ? null : substr((string) $booking->end_time, 0, 5),
            'duration_minutes' => $booking->duration_minutes,
            'teaching_mode' => $booking->teaching_mode,
            'booking_type' => $booking->booking_type ?? 'demo',
            'status' => $booking->status,
            'agreed_price' => $booking->agreed_price !== null ? (float) $booking->agreed_price : null,
            'pricing_type' => $booking->pricing_type,
            'admin_notes' => $booking->admin_notes,
            'student_phone' => $booking->student?->phone,
            'student_email' => $booking->student?->email,
            'teacher_phone' => $booking->teacher?->phone,
            'teacher_email' => $booking->teacher?->email,
            'message' => $booking->message,
            'rejection_reason' => $booking->rejection_reason,
            'decided_at' => $booking->decided_at?->toIso8601String(),
            'approved_at' => $booking->approved_at?->toIso8601String(),
            'cancelled_at' => $booking->cancelled_at?->toIso8601String(),
            'completed_at' => $booking->completed_at?->toIso8601String(),
            'created_at' => $booking->created_at?->toIso8601String(),
            'attendance' => $attendance === null ? null : [
                'id' => $attendance->id,
                'confirmation' => $attendance->confirmation,
                'result' => $attendance->result,
                'current_result' => $attendance->current_result,
            ],
            'review' => $review === null ? null : [
                'id' => $review->id,
                'rating' => $review->rating,
                'status' => $review->status,
            ],
        ];
    }
}
