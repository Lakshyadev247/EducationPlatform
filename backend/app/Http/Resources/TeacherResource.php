<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\Storage;

class TeacherResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        $profile = $this->resource;
        $user = $profile->user;
        $location = $profile->serviceLocations->firstWhere('is_primary', true)
            ?? $profile->serviceLocations->first();

        $availability = $profile->availability
            ->sortBy([['day_of_week', 'asc'], ['start_time', 'asc']])
            ->map(fn ($slot): array => [
                'id' => $slot->id,
                'day_of_week' => $slot->day_of_week,
                'day' => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][$slot->day_of_week] ?? '',
                'start_time' => substr((string) $slot->start_time, 0, 5),
                'end_time' => substr((string) $slot->end_time, 0, 5),
            ])->values();

        $prices = [];
        foreach ($profile->prices as $price) {
            $prices[$price->pricing_type] = [
                'amount' => (float) $price->amount,
                'currency' => $price->currency,
            ];
        }

        $published = $profile->reviews->where('status', 'published');
        $average = $profile->getAttribute('rating_average');
        if ($average === null && $published->count() > 0) {
            $average = round((float) $published->avg('rating'), 2);
        }
        $reviewCount = $profile->getAttribute('review_count');
        if ($reviewCount === null) {
            $reviewCount = $published->count();
        }

        $owner = $request->user()?->id === $profile->user_id;
        $admin = $request->user()?->isAdmin() ?? false;

        return [
            'id' => $user->id,
            'name' => $user->name,
            'bio' => $profile->bio,
            'photo_url' => $profile->photo_path ? Storage::disk('public')->url($profile->photo_path) : null,
            'experience_level' => $profile->experience_level,
            'experience_years' => $profile->experience_years === null ? null : (float) $profile->experience_years,
            'experience_org' => $profile->experience_org,
            'experience_description' => $profile->experience_description,
            'teaching_mode' => $profile->teaching_mode,
            'online_tools' => $profile->online_tools,
            'subjects' => $profile->subjects->map(fn ($subject): array => [
                'id' => $subject->id,
                'name' => $subject->name,
                'slug' => $subject->slug,
            ])->values(),
            'grades' => $profile->educationLevels->map(fn ($level): array => [
                'id' => $level->id,
                'key' => $level->key,
                'label' => $level->label,
            ])->values(),
            'streams' => $profile->streams->map(fn ($stream): array => [
                'id' => $stream->id,
                'key' => $stream->key,
                'label' => $stream->label,
            ])->values(),
            'level_other' => $profile->level_other,
            'qualifications' => $profile->qualifications->map(fn ($qualification): array => [
                'id' => $qualification->id,
                'name' => $qualification->name,
                'institution' => $qualification->institution,
                'year' => $qualification->year_completed,
            ])->values(),
            'location' => $location === null ? null : [
                'area' => $location->area,
                'city' => $location->city,
                'state' => $location->state,
                'country' => $location->country,
                'radius_km' => $location->teaching_radius_km,
            ],
            'availability' => $availability,
            'prices' => $prices,
            'rating_average' => $average === null ? null : (float) $average,
            'review_count' => (int) $reviewCount,
            'documents_verified' => ((bool) app(\App\Services\SettingsService::class)->get('general.requireTeacherDocumentVerification', true)) && $profile->document_verification_status === 'verified',
            'document_verification_status' => $owner || $admin ? $profile->document_verification_status : null,
            'document_verified_at' => ($owner || $admin) ? $profile->document_verified_at?->toIso8601String() : null,
            'document_rejection_reason' => ($owner || $admin) ? $profile->document_rejection_reason : null,
            'id_document' => ($owner || $admin) && $profile->idDocument ? [
                'id' => $profile->idDocument->id,
                'name' => $profile->idDocument->original_name,
                'size' => $profile->idDocument->formatted_size,
                'mime' => $profile->idDocument->mime_type,
                'created_at' => $profile->idDocument->created_at?->toIso8601String(),
            ] : null,
            'qualification_document' => ($owner || $admin) && $profile->qualificationDocument ? [
                'id' => $profile->qualificationDocument->id,
                'name' => $profile->qualificationDocument->original_name,
                'size' => $profile->qualificationDocument->formatted_size,
                'mime' => $profile->qualificationDocument->mime_type,
                'created_at' => $profile->qualificationDocument->created_at?->toIso8601String(),
            ] : null,
            'approval_status' => $owner || $admin ? $profile->approval_status : null,
            'is_public' => $owner || $admin ? (bool) $profile->is_public : null,
            'listing_diagnostic' => ($owner || $admin) ? $profile->getListingDiagnostic() : null,
            'completed' => $profile->completed_at !== null,
            'completed_at' => $profile->completed_at?->toIso8601String(),
            'created_at' => $profile->created_at?->toIso8601String(),
            'updated_at' => $profile->updated_at?->toIso8601String(),
        ];
    }
}
