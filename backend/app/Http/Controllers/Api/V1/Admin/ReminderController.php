<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Services\AttendanceReminderService;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ReminderController extends Controller
{
    /**
     * Run the attendance reminder routine.
     *
     * Authorised by the route's role middleware (admin, super_admin). Safe to
     * call repeatedly: AttendanceReminderService deduplicates on a per-record
     * attempt key, so a second call creates nothing new. The response reports
     * the count the server actually created — the UI must show this, not a
     * number it made up.
     */
    public function run(Request $request, AttendanceReminderService $reminders, AuditLogger $auditLogger): JsonResponse
    {
        $result = $reminders->run();

        $auditLogger->record(
            $request->user(),
            'reminders.run',
            'attendance',
            null,
            [],
            ['created' => $result['created'], 'candidates' => $result['candidates']],
        );

        return response()->json([
            'data' => [
                'created' => $result['created'],
                'candidates' => $result['candidates'],
                'reason' => $result['reason'],
            ],
        ]);
    }
}
