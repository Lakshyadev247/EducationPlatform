<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Storage;

class StudentProfileResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $profile = $this->resource;
        $user = $profile->user;

        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'phone' => $user->phone,
            'status' => $user->status,
            'level' => $profile->educationLevel?->key,
            'level_label' => $profile->educationLevel?->label,
            'level_other' => $profile->level_other,
            'intro' => $profile->intro,
            'photo_url' => $profile->photo_path ? Storage::disk('public')->url($profile->photo_path) : null,
            'completed' => $profile->completed_at !== null,
            'completed_at' => $profile->completed_at?->toIso8601String(),
            'created_at' => $profile->created_at?->toIso8601String(),
            'updated_at' => $profile->updated_at?->toIso8601String(),
        ];
    }
}
