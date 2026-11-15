<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class AttendanceResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $record = $this->resource;
        $booking = $record->booking;

        return [
            'id' => $record->id,
            'booking_id' => $record->booking_id,
            'booking_reference' => $booking?->reference,
            'teacher_id' => $record->teacher_id,
            'teacher_name' => $record->teacher?->name,
            'student_id' => $record->student_id,
            'student_name' => $record->student?->name,
            'subject' => $booking?->subject?->name,
            'date' => $booking?->booking_date?->toDateString(),
            'start_time' => $booking === null ? null : substr((string) $booking->start_time, 0, 5),
            'teaching_mode' => $booking?->teaching_mode,
            'result' => $record->result,
            'current_result' => $record->current_result,
            'absence_reason' => $record->absence_reason,
            'confirmation' => $record->confirmation,
            'student_response' => $record->student_response,
            'marked_at' => $record->marked_at?->toIso8601String(),
            'responded_at' => $record->responded_at?->toIso8601String(),
            'resolved_at' => $record->resolved_at?->toIso8601String(),
            'corrections' => $record->relationLoaded('corrections') ? $record->corrections->map(fn ($correction): array => [
                'id' => $correction->id,
                'attendance_id' => $correction->attendance_id,
                'requester_id' => $correction->requester_id,
                'requester_role' => $correction->requester_role,
                'explanation' => $correction->explanation,
                'status' => $correction->status,
                'created_at' => $correction->created_at?->toIso8601String(),
                'resolved_at' => $correction->resolved_at?->toIso8601String(),
            ])->values() : [],
            'decisions' => $record->relationLoaded('decisions') ? $record->decisions->map(fn ($decision): array => [
                'id' => $decision->id,
                'attendance_id' => $decision->attendance_id,
                'correction_id' => $decision->correction_id,
                'reviewer_id' => $decision->reviewer_id,
                'decision_type' => $decision->decision_type,
                'original_result' => $decision->original_result,
                'final_result' => $decision->final_result,
                'reason' => $decision->reason,
                'decided_at' => $decision->decided_at?->toIso8601String(),
            ])->values() : [],
            'created_at' => $record->created_at?->toIso8601String(),
        ];
    }
}
