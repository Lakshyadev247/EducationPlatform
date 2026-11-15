<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class NotificationResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'category' => $this->category,
            'title' => $this->title,
            'message' => $this->message,
            'read' => $this->read_at !== null,
            'read_at' => $this->read_at?->toIso8601String(),
            'ref_type' => $this->ref_type,
            // Exposed so the client can tell which reminders were already sent
            // for a record. It is an opaque idempotency token (e.g.
            // "reminder:12:attempt1"), contains no credential, and is only ever
            // returned to the notification's own owner.
            'dedupe_key' => $this->dedupe_key,
            'ref_id' => $this->ref_id,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
