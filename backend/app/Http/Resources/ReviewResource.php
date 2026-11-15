<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class ReviewResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $review = $this->resource;
        $viewer = $request->user();
        $isAdmin = $viewer?->isAdmin() ?? false;
        $isOwner = $viewer?->id === $review->student_id;

        $displayName = $review->student?->name ?? 'Student';
        $parts = preg_split('/\s+/', trim($displayName));
        if (count($parts) > 1) {
            $displayName = $parts[0].' '.mb_substr(end($parts), 0, 1).'.';
        }

        return [
            'id' => $review->id,
            'student_id' => $this->when($isOwner || $isAdmin, $review->student_id),
            'student_name' => $isOwner || $isAdmin ? $review->student?->name : $displayName,
            'teacher_id' => $review->teacher_id,
            'teacher_name' => $review->teacher?->name,
            'booking_id' => $review->booking_id,
            'rating' => $review->rating,
            'text' => $review->text,
            'status' => $review->status,
            'moderation_note' => $isAdmin || $isOwner ? $review->moderation_note : null,
            'published_at' => $review->published_at?->toIso8601String(),
            'created_at' => $review->created_at?->toIso8601String(),
        ];
    }
}
