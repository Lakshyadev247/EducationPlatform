<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\AttendanceResource;
use App\Models\AttendanceCorrection;
use App\Models\AttendanceDecision;
use App\Models\AttendanceRecord;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use App\Services\SettingsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class AttendanceController extends Controller
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'filter' => ['nullable', Rule::in(['open', 'all', 'disputed', 'corrections'])],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $query = AttendanceRecord::query()
            ->with([
                'booking.student:id,name',
                'booking.subject',
                'booking',
                'teacher:id,name',
                'student:id,name',
                'corrections.requester:id,name',
                'decisions.reviewer:id,name',
            ])
            ->orderByDesc('marked_at');

        $filter = $filters['filter'] ?? 'open';
        if ($filter === 'open') {
            $query->where(fn ($q) => $q
                ->where('confirmation', 'disputed')
                ->orWhereHas('corrections', fn ($c) => $c->where('status', 'pending')));
        } elseif ($filter === 'disputed') {
            $query->where('confirmation', 'disputed');
        } elseif ($filter === 'corrections') {
            $query->whereHas('corrections', fn ($c) => $c->where('status', 'pending'));
        }

        return AttendanceResource::collection($query->paginate((int) ($filters['per_page'] ?? 50)))->response();
    }

    public function decide(Request $request, AttendanceRecord $attendance, AuditLogger $auditLogger, NotificationService $notifications): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'decision_type' => ['required', Rule::in(['uphold', 'approve-correction', 'reject-correction', 'keep-pending'])],
            'reason' => ['required', 'string', 'min:3', 'max:400'],
            'correction_id' => ['nullable', 'integer', 'exists:attendance_corrections,id'],
        ]);

        $correction = null;
        if (! empty($data['correction_id'])) {
            $correction = AttendanceCorrection::query()
                ->whereKey($data['correction_id'])
                ->where('attendance_id', $attendance->id)
                ->where('status', 'pending')
                ->first();
        } else {
            $correction = $attendance->corrections()->where('status', 'pending')->latest()->first();
        }

        if ($data['decision_type'] === 'approve-correction' && $correction === null && $attendance->confirmation !== AttendanceRecord::CONFIRMATION_DISPUTED) {
            throw ValidationException::withMessages(['correction_id' => ['There is no open correction to approve.']]);
        }

        $decision = DB::transaction(function () use ($attendance, $data, $correction, $request, $auditLogger): AttendanceDecision {
            $originalResult = $attendance->result;
            $finalResult = $attendance->current_result ?? $attendance->result;

            if ($data['decision_type'] === 'approve-correction') {
                $finalResult = $originalResult === 'present' ? 'absent' : 'present';
                $attendance->current_result = $finalResult;
                $attendance->confirmation = AttendanceRecord::CONFIRMATION_CONFIRMED;
                $attendance->resolved_at = now();
                $correction?->forceFill([
                    'status' => 'approved',
                    'resolved_at' => now(),
                    'resolved_by' => $request->user()->id,
                ])->save();
            } elseif ($data['decision_type'] === 'uphold') {
                $finalResult = $originalResult;
                $attendance->current_result = $originalResult;
                $attendance->confirmation = AttendanceRecord::CONFIRMATION_CONFIRMED;
                $attendance->resolved_at = now();
                $correction?->forceFill([
                    'status' => 'upheld',
                    'resolved_at' => now(),
                    'resolved_by' => $request->user()->id,
                ])->save();
            } elseif ($data['decision_type'] === 'reject-correction') {
                $finalResult = $originalResult;
                $attendance->current_result = $originalResult;
                $attendance->confirmation = AttendanceRecord::CONFIRMATION_CONFIRMED;
                $attendance->resolved_at = now();
                $correction?->forceFill([
                    'status' => 'rejected',
                    'resolved_at' => now(),
                    'resolved_by' => $request->user()->id,
                ])->save();
            }

            $attendance->save();

            $decision = AttendanceDecision::query()->create([
                'attendance_id' => $attendance->id,
                'correction_id' => $correction?->id,
                'reviewer_id' => $request->user()->id,
                'decision_type' => $data['decision_type'],
                'original_result' => $originalResult,
                'final_result' => $finalResult,
                'reason' => trim($data['reason']),
                'decided_at' => now(),
            ]);

            $auditLogger->record(
                $request->user(),
                'attendance.decided',
                AttendanceRecord::class,
                $attendance->id,
                ['result' => $originalResult, 'confirmation' => 'disputed'],
                ['current_result' => $finalResult, 'confirmation' => $attendance->confirmation, 'decision_type' => $data['decision_type']],
                trim($data['reason']),
            );

            return $decision;
        });

        // The resolution notice is an independent switch. The general
        // notification setting for the category still applies on top of it.
        if ((bool) $this->settings->get('notifications.notifyPartiesOnResolution', true)) {
            foreach ([$attendance->student_id, $attendance->teacher_id] as $recipient) {
                $notifications->send(
                    $recipient,
                    'dispute-resolved',
                    'Attendance case resolved',
                    'A decision was recorded for booking '.$attendance->booking->reference.'.',
                    'attendance',
                    $attendance->id,
                    'attendance-decision:'.$decision->id.':'.$recipient,
                );
            }
        }

        return response()->json([
            'data' => [
                'id' => $decision->id,
                'attendance_id' => $decision->attendance_id,
                'decision_type' => $decision->decision_type,
                'original_result' => $decision->original_result,
                'final_result' => $decision->final_result,
                'reason' => $decision->reason,
                'decided_at' => $decision->decided_at?->toIso8601String(),
                'attendance' => (new AttendanceResource($attendance->fresh([
                    'booking.subject', 'teacher:id,name', 'student:id,name', 'corrections', 'decisions',
                ])))->resolve(),
            ],
        ], 201);
    }
}
