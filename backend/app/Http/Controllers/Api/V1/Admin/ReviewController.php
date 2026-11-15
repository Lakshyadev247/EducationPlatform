<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\ReviewResource;
use App\Models\Review;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class ReviewController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $filters = $request->validate([
            'status' => ['nullable', Rule::in(['published', 'hidden', 'flagged'])],
            'q' => ['nullable', 'string', 'max:100'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $query = Review::query()
            ->with(['student:id,name', 'teacher:id,name'])
            ->latest();

        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (! empty($filters['q'])) {
            $term = '%'.trim($filters['q']).'%';
            $query->where(fn ($q) => $q->where('text', 'like', $term)
                ->orWhereHas('teacher', fn ($t) => $t->where('name', 'like', $term))
                ->orWhereHas('student', fn ($s) => $s->where('name', 'like', $term)));
        }

        return ReviewResource::collection($query->paginate((int) ($filters['per_page'] ?? 50)))->response();
    }

    public function moderate(Request $request, Review $review, AuditLogger $auditLogger, NotificationService $notifications): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'status' => ['required', Rule::in(['published', 'hidden', 'flagged'])],
            'note' => ['nullable', 'string', 'max:400'],
        ]);

        $old = $review->status;
        $review->forceFill([
            'status' => $data['status'],
            'moderation_note' => $data['note'] ?? null,
            'moderated_by' => $request->user()->id,
            'moderated_at' => now(),
            'published_at' => $data['status'] === 'published' ? ($review->published_at ?? now()) : null,
        ])->save();

        $auditLogger->record(
            $request->user(),
            'review.moderated',
            Review::class,
            $review->id,
            ['status' => $old],
            ['status' => $review->status, 'note' => $review->moderation_note],
            $data['note'] ?? null,
        );

        $notifications->send(
            $review->student_id,
            'review-update',
            'Review moderation updated',
            'Your review for '.$review->teacher?->name.' is now '.$review->status.'.',
            'review',
            $review->id,
            'review-moderated:'.$review->id.':'.$review->status.':'.now()->timestamp,
        );

        return (new ReviewResource($review->fresh(['student:id,name', 'teacher:id,name'])))->response();
    }
}
