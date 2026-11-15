<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\AuditLog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AuditLogController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'action' => ['nullable', 'string', 'max:80'],
            'actor_id' => ['nullable', 'integer', 'exists:users,id'],
            'search' => ['nullable', 'string', 'max:100'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $query = AuditLog::query()
            ->with('actor:id,name')
            ->latest('id');

        if (! empty($filters['action'])) {
            $query->where('action', 'like', '%'.$filters['action'].'%');
        }

        if (! empty($filters['actor_id'])) {
            $query->where('actor_id', $filters['actor_id']);
        }

        if (! empty($filters['search'])) {
            $search = $filters['search'];
            $query->where(function ($q) use ($search) {
                $q->where('action', 'like', '%'.$search.'%')
                  ->orWhere('entity_type', 'like', '%'.$search.'%')
                  ->orWhere('entity_id', 'like', '%'.$search.'%')
                  ->orWhere('reason', 'like', '%'.$search.'%');
            });
        }

        $logs = $query->paginate((int) ($filters['per_page'] ?? 50));

        $distinctActions = AuditLog::query()
            ->distinct()
            ->pluck('action')
            ->filter()
            ->values();

        return response()->json([
            'data' => $logs->getCollection()->map(fn (AuditLog $log): array => [
                'id' => $log->id,
                'actor_id' => $log->actor_id,
                'actor_name' => $log->actor?->name,
                'action' => $log->action,
                'entity_type' => $log->entity_type,
                'entity_id' => $log->entity_id,
                'old_values' => $log->old_values,
                'new_values' => $log->new_values,
                'reason' => $log->reason,
                'created_at' => $log->created_at?->toIso8601String(),
            ])->values(),
            'meta' => [
                'current_page' => $logs->currentPage(),
                'last_page' => $logs->lastPage(),
                'total' => $logs->total(),
                'available_actions' => $distinctActions,
            ],
        ]);
    }

    public function clear(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'action' => ['nullable', 'string', 'max:80'],
            'actor_id' => ['nullable', 'integer', 'exists:users,id'],
        ]);

        $query = AuditLog::query();

        if (! empty($filters['action'])) {
            $query->where('action', 'like', '%'.$filters['action'].'%');
        }

        if (! empty($filters['actor_id'])) {
            $query->where('actor_id', $filters['actor_id']);
        }

        $count = $query->count();
        $query->delete();

        return response()->json([
            'message' => 'Audit logs cleared successfully.',
            'deleted' => $count,
        ]);
    }
}
