<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\AttendanceRecord;
use App\Models\Booking;
use App\Models\Role;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

class ReportController extends Controller
{
    public function attendanceCsv(Request $request): StreamedResponse
    {
        $user = $request->user();
        $query = AttendanceRecord::query()
            ->with(['booking.subject', 'teacher:id,name', 'student:id,name'])
            ->orderBy('marked_at');

        if ($user->hasRole(Role::TEACHER)) {
            $query->where('teacher_id', $user->id);
        } elseif ($user->hasRole(Role::STUDENT)) {
            $query->where('student_id', $user->id);
        } elseif (! $user->isAdmin()) {
            abort(403);
        }

        $filename = 'attendance-'.now('Asia/Kolkata')->format('Ymd-His').'.csv';

        return response()->streamDownload(function () use ($query): void {
            $out = fopen('php://output', 'wb');
            fwrite($out, "\xEF\xBB\xBF");
            fputcsv($out, ['Reference', 'Date', 'Time', 'Student', 'Teacher', 'Subject', 'Teacher result', 'Current result', 'Confirmation', 'Student response', 'Marked at']);

            $query->chunk(500, function ($records) use ($out): void {
                foreach ($records as $record) {
                    fputcsv($out, [
                        $this->cell($record->booking?->reference),
                        $this->cell($record->booking?->booking_date?->toDateString()),
                        $this->cell($record->booking?->start_time === null ? null : substr((string) $record->booking->start_time, 0, 5)),
                        $this->cell($record->student?->name),
                        $this->cell($record->teacher?->name),
                        $this->cell($record->booking?->subject?->name),
                        $this->cell($record->result),
                        $this->cell($record->current_result),
                        $this->cell($record->confirmation),
                        $this->cell($record->student_response),
                        $this->cell($record->marked_at?->toIso8601String()),
                    ]);
                }
            });

            fclose($out);
        }, $filename, ['Content-Type' => 'text/csv; charset=UTF-8']);
    }

    public function bookingsCsv(Request $request): StreamedResponse
    {
        $user = $request->user();
        $query = Booking::query()
            ->with(['student:id,name', 'teacher:id,name', 'subject:id,name'])
            ->orderBy('booking_date')
            ->orderBy('start_time');

        if ($user->hasRole(Role::TEACHER)) {
            $query->where('teacher_id', $user->id);
        } elseif ($user->hasRole(Role::STUDENT)) {
            $query->where('student_id', $user->id);
        } elseif (! $user->isAdmin()) {
            abort(403);
        }

        $filename = 'bookings-'.now('Asia/Kolkata')->format('Ymd-His').'.csv';

        return response()->streamDownload(function () use ($query): void {
            $out = fopen('php://output', 'wb');
            fwrite($out, "\xEF\xBB\xBF");
            fputcsv($out, ['Reference', 'Date', 'Time', 'Student', 'Teacher', 'Subject', 'Mode', 'Status']);

            $query->chunk(500, function ($bookings) use ($out): void {
                foreach ($bookings as $booking) {
                    fputcsv($out, [
                        $this->cell($booking->reference),
                        $this->cell($booking->booking_date?->toDateString()),
                        $this->cell(substr((string) $booking->start_time, 0, 5)),
                        $this->cell($booking->student?->name),
                        $this->cell($booking->teacher?->name),
                        $this->cell($booking->subject?->name),
                        $this->cell($booking->teaching_mode),
                        $this->cell($booking->status),
                    ]);
                }
            });

            fclose($out);
        }, $filename, ['Content-Type' => 'text/csv; charset=UTF-8']);
    }

    private function cell(mixed $value): string
    {
        $text = $value === null ? '' : (string) $value;

        // Spreadsheet formula injection protection.
        if (preg_match('/^[=+\-@\t\r]/', $text) === 1) {
            $text = "'".$text;
        }

        return $text;
    }
}
