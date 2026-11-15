<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\NotificationResource;
use App\Models\Notification;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NotificationController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $request->validate([
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
            'unread' => ['nullable', 'boolean'],
        ]);

        $query = Notification::query()
            ->where('user_id', $request->user()->id)
            ->latest();

        if ($request->boolean('unread')) {
            $query->whereNull('read_at');
        }

        return NotificationResource::collection($query->paginate((int) $request->query('per_page', 50)))->response();
    }

    public function unreadCount(Request $request): JsonResponse
    {
        return response()->json([
            'data' => [
                'unread' => Notification::query()
                    ->where('user_id', $request->user()->id)
                    ->whereNull('read_at')
                    ->count(),
            ],
        ]);
    }

    public function markRead(Request $request, Notification $notification): NotificationResource
    {
        abort_unless($notification->user_id === $request->user()->id, 403);

        if ($notification->read_at === null) {
            $notification->forceFill(['read_at' => now()])->save();
        }

        return new NotificationResource($notification);
    }

    public function markAllRead(Request $request): JsonResponse
    {
        $count = Notification::query()
            ->where('user_id', $request->user()->id)
            ->whereNull('read_at')
            ->update(['read_at' => now()]);

        return response()->json(['message' => 'Notifications marked as read.', 'data' => ['updated' => $count]]);
    }
}
