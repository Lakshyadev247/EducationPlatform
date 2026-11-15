<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\ReviewResource;
use App\Models\Booking;
use App\Models\Review;
use App\Models\Role;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\NotificationService;
use App\Services\ReviewEligibilityService;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class ReviewController extends Controller
{
    /**
     * The length rules of a review. They are the same as the check
     * constraint the database holds, so a review that passes the validation
     * is always one the database accepts.
     */
    private const REVIEW_TEXT_MIN = 20;

    private const REVIEW_TEXT_MAX = 600;

    public function __construct(
        private readonly ReviewEligibilityService $eligibility,
        private readonly NotificationService $notifications,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $query = Review::query()
            ->with(['student:id,name', 'teacher:id,name'])
            ->latest();

        if ($user->hasRole(Role::STUDENT)) {
            $query->where('student_id', $user->id);
        } elseif ($user->hasRole(Role::TEACHER)) {
            $query->where('teacher_id', $user->id)->where('status', 'published');
        } elseif (! $user->isAdmin()) {
            abort(403);
        }

        return ReviewResource::collection($query->paginate(50))->response();
    }

    public function eligibility(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT), 403);

        $data = $request->validate([
            'teacher_id' => ['required', 'integer', 'exists:users,id'],
            'booking_id' => ['nullable', 'integer', 'exists:bookings,id'],
        ]);

        $result = $this->eligibility->evaluate($user, (int) $data['teacher_id'], isset($data['booking_id']) ? (int) $data['booking_id'] : null);

        return response()->json(['data' => $result]);
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT), 403);

        $data = $request->validate([
            'teacher_id' => ['nullable', 'integer', 'exists:users,id'],
            'booking_id' => ['required', 'integer', 'exists:bookings,id'],
            'rating' => ['required', 'integer', 'between:1,5'],
        ]);
        $text = $this->validatedText($request);

        // A review is always about one completed lesson of this student with
        // this teacher. Ownership is checked here, before anything is stored.
        $booking = Booking::query()->whereKey($data['booking_id'])->where('student_id', $user->id)->first();

        if ($booking === null) {
            throw ValidationException::withMessages(['booking_id' => ['That lesson does not belong to you.']]);
        }

        $teacherId = (int) ($data['teacher_id'] ?? $booking->teacher_id);

        if ($booking->teacher_id !== $teacherId) {
            throw ValidationException::withMessages(['teacher_id' => ['The teacher does not match the lesson.']]);
        }

        $teacher = User::query()
            ->whereKey($teacherId)
            ->whereHas('roles', fn ($q) => $q->where('name', Role::TEACHER))
            ->first();

        if ($teacher === null) {
            throw ValidationException::withMessages(['teacher_id' => ['That teacher could not be found.']]);
        }

        $eligibility = $this->eligibility->evaluate($user, $teacherId, (int) $booking->id);
        if (! $eligibility['eligible']) {
            throw ValidationException::withMessages(['rating' => [$eligibility['reason']]]);
        }

        try {
            $review = Review::query()->create([
                'student_id' => $user->id,
                'teacher_id' => $teacherId,
                'booking_id' => $booking->id,
                'rating' => $data['rating'],
                'text' => $text,
                'status' => 'published',
                'published_at' => now(),
            ]);
        } catch (QueryException $exception) {
            if (str_contains(strtolower($exception->getMessage()), 'duplicate')) {
                throw ValidationException::withMessages(['rating' => ['You have already reviewed this lesson.']]);
            }
            throw $exception;
        }

        $this->notifications->send(
            $teacher,
            'review-update',
            'New review published',
            $user->name.' left you a '.$data['rating'].'/5 review.',
            'review',
            $review->id,
            'review-created:'.$review->id,
        );

        return (new ReviewResource($review->load(['student:id,name', 'teacher:id,name'])))
            ->response()
            ->setStatusCode(201);
    }

    /**
     * A student corrects their own review.
     *
     * Only the rating and the text are changed. The moderation state is left
     * exactly as it is, so an edit never republishes a review that an
     * administrator unpublished, and the lesson, the attendance, the student
     * and the teacher are never touched.
     */
    public function update(Request $request, Review $review, AuditLogger $auditLogger): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT), 403);

        // A student may only change their own review. The id in the request
        // never decides whose review it is.
        abort_unless($review->student_id === $user->id, 403);

        $data = $request->validate([
            'rating' => ['required', 'integer', 'between:1,5'],
        ]);
        $text = $this->validatedText($request);

        // The lesson behind the review still has to be this student's lesson
        // with this teacher.
        $booking = Booking::query()
            ->whereKey($review->booking_id)
            ->where('student_id', $user->id)
            ->where('teacher_id', $review->teacher_id)
            ->first();

        if ($booking === null) {
            throw ValidationException::withMessages([
                'booking_id' => ['The lesson behind this review is no longer yours.'],
            ]);
        }

        $old = [
            'rating' => $review->rating,
            'text' => $review->text,
            'status' => $review->status,
        ];

        $review->forceFill([
            'rating' => $data['rating'],
            'text' => $text,
        ])->save();

        $auditLogger->record(
            $user,
            'review.updated',
            Review::class,
            $review->id,
            $old,
            ['rating' => $review->rating, 'text' => $review->text, 'status' => $review->status],
        );

        // The teacher is only told about the change when the review is still
        // one they can see.
        if ($review->status === 'published') {
            $this->notifications->send(
                $review->teacher_id,
                'review-update',
                'A review was edited',
                $user->name.' edited their review of you.',
                'review',
                $review->id,
                'review-edited:'.$review->id.':'.now()->timestamp,
            );
        }

        return (new ReviewResource($review->fresh(['student:id,name', 'teacher:id,name'])))->response();
    }

    /**
     * A student removes their own review.
     *
     * The lesson, the attendance, the student and the teacher stay exactly as
     * they are. Removing the review frees the lesson, so the student may
     * write a replacement for it.
     */
    public function destroy(Request $request, Review $review, AuditLogger $auditLogger): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->hasRole(Role::STUDENT), 403);
        abort_unless($review->student_id === $user->id, 403);

        $teacherId = $review->teacher_id;
        $wasPublished = $review->status === 'published';
        $rating = $review->rating;
        $status = $review->status;
        $bookingId = $review->booking_id;

        $review->delete();

        $auditLogger->record(
            $user,
            'review.deleted',
            Review::class,
            $review->id,
            ['rating' => $rating, 'status' => $status, 'booking_id' => $bookingId],
            [],
        );

        if ($wasPublished) {
            $this->notifications->send(
                $teacherId,
                'review-update',
                'A review was removed',
                $user->name.' removed their review of you.',
                'review',
                $review->id,
                'review-deleted:'.$review->id.':'.now()->timestamp,
            );
        }

        return response()->json([
            'message' => 'The review was removed. The lesson and its records are unchanged.',
        ]);
    }

    /**
     * The review text as it is stored.
     *
     * The length is checked on the trimmed text, because the database holds a
     * check constraint on the stored length. A review of only spaces, or one
     * that is long enough before trimming and too short after it, is refused
     * with the same clear message.
     */
    private function validatedText(Request $request): string
    {
        $data = $request->validate(
            ['text' => ['nullable', 'string', 'max:'.self::REVIEW_TEXT_MAX]],
            ['text.max' => 'Keep your review under '.self::REVIEW_TEXT_MAX.' characters.'],
        );

        $text = trim((string) ($data['text'] ?? ''));

        if (mb_strlen($text) < self::REVIEW_TEXT_MIN) {
            throw ValidationException::withMessages([
                'text' => ['Write at least '.self::REVIEW_TEXT_MIN.' characters so the review is useful.'],
            ]);
        }

        return $text;
    }
}
