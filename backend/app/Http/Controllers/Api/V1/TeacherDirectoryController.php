<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\ReviewResource;
use App\Http\Resources\TeacherResource;
use App\Models\Review;
use App\Models\TeacherProfile;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class TeacherDirectoryController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $filters = $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'subject' => ['nullable', 'string', 'max:100'],
            'level' => ['nullable', 'string', 'max:40'],
            'mode' => ['nullable', 'in:online,in-person,both'],
            'city' => ['nullable', 'string', 'max:120'],
            'state' => ['nullable', 'string', 'max:120'],
            'day' => ['nullable', 'in:mon,tue,wed,thu,fri,sat,sun'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:24'],
            'page' => ['nullable', 'integer', 'min:1'],
        ]);

        $dayMap = ['sun' => 0, 'mon' => 1, 'tue' => 2, 'wed' => 3, 'thu' => 4, 'fri' => 5, 'sat' => 6];

        $query = TeacherProfile::query()
            ->publiclyVisible()
            ->whereHas('user', fn (Builder $q) => $q->where('status', 'active'))
            ->with([
                'user',
                'subjects',
                'educationLevels',
                'streams',
                'qualifications',
                'serviceLocations',
                'availability',
                'prices',
            ])
            ->withCount([
                'reviews as review_count' => fn (Builder $q) => $q->where('status', 'published'),
            ])
            ->withAvg([
                'reviews as rating_average' => fn (Builder $q) => $q->where('status', 'published'),
            ], 'rating');

        if (! empty($filters['q'])) {
            $term = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], trim($filters['q'])).'%';
            $query->where(function (Builder $inner) use ($term): void {
                $inner->whereHas('user', fn (Builder $q) => $q->where('name', 'like', $term))
                    ->orWhere('bio', 'like', $term)
                    ->orWhereHas('subjects', fn (Builder $q) => $q->where('name', 'like', $term));
            });
        }

        if (! empty($filters['subject'])) {
            $subject = trim($filters['subject']);
            $query->whereHas('subjects', function (Builder $q) use ($subject): void {
                $q->where('name', $subject)->orWhere('slug', $subject)->orWhere('id', $subject);
            });
        }

        if (! empty($filters['level'])) {
            $level = $filters['level'];
            $query->whereHas('educationLevels', fn (Builder $q) => $q->where('key', $level));
        }

        if (! empty($filters['mode'])) {
            $mode = $filters['mode'];
            $query->where(function (Builder $q) use ($mode): void {
                $q->where('teaching_mode', $mode);
                if (in_array($mode, ['online', 'in-person'], true)) {
                    $q->orWhere('teaching_mode', 'both');
                }
            });
        }

        if (! empty($filters['city'])) {
            $city = trim($filters['city']);
            $query->whereHas('serviceLocations', fn (Builder $q) => $q->where('city', 'like', '%'.$city.'%'));
        }

        if (! empty($filters['state'])) {
            $state = trim($filters['state']);
            $query->whereHas('serviceLocations', fn (Builder $q) => $q->where('state', 'like', '%'.$state.'%'));
        }

        if (! empty($filters['day'])) {
            $day = $dayMap[$filters['day']];
            $query->whereHas('availability', fn (Builder $q) => $q->where('day_of_week', $day));
        }

        $teachers = $query
            ->orderByDesc('rating_average')
            ->orderByDesc('review_count')
            ->orderBy('user_id')
            ->paginate((int) ($filters['per_page'] ?? 12))
            ->withQueryString();

        return TeacherResource::collection($teachers)->response();
    }

    public function show(Request $request, int $teacher): JsonResponse
    {
        $query = TeacherProfile::query()
            ->with([
                'user',
                'subjects',
                'educationLevels',
                'streams',
                'qualifications',
                'serviceLocations',
                'availability',
                'prices',
            ])
            ->withCount([
                'reviews as review_count' => fn (Builder $q) => $q->where('status', 'published'),
            ])
            ->withAvg([
                'reviews as rating_average' => fn (Builder $q) => $q->where('status', 'published'),
            ], 'rating')
            ->where('user_id', $teacher);

        $viewer = $request->user();
        if (! ($viewer !== null && ($viewer->id === $teacher || $viewer->isAdmin()))) {
            $query->publiclyVisible()->whereHas('user', fn (Builder $q) => $q->where('status', 'active'));
        }

        $profile = $query->firstOrFail();

        return response()->json(['data' => (new TeacherResource($profile))->resolve()]);
    }

    public function reviews(Request $request, int $teacher): JsonResponse
    {
        $request->validate([
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);

        $profile = TeacherProfile::query()
            ->publiclyVisible()
            ->where('user_id', $teacher)
            ->firstOrFail();

        $reviews = Review::query()
            ->where('teacher_id', $profile->user_id)
            ->where('status', 'published')
            ->with(['student:id,name', 'teacher:id,name'])
            ->latest('published_at')
            ->paginate((int) ($request->query('per_page', 10)));

        return ReviewResource::collection($reviews)->response();
    }
}
