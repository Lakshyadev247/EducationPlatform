<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\TermsVersion;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class TermsController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $versions = TermsVersion::query()
            ->where('is_current', true)
            ->orderBy('audience')
            ->get()
            ->keyBy('audience');

        // Built-in audiences plus any custom published policies
        $allAudiences = collect(['common', 'privacy', 'student', 'teacher'])
            ->merge($versions->keys())
            ->unique()
            ->values();

        return response()->json([
            'data' => $allAudiences->map(fn (string $audience): array => [
                'audience' => $audience,
                'version' => $versions->get($audience)?->version,
                'title' => $versions->get($audience)?->title,
                'body' => $versions->get($audience)?->body,
                'effective_date' => $versions->get($audience)?->effective_date?->toDateString(),
                'published_at' => $versions->get($audience)?->published_at?->toIso8601String(),
            ])->values(),
        ]);
    }

    public function publish(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'audience' => ['required', 'string', 'max:60'],
            'title' => ['nullable', 'string', 'max:160'],
            'body' => ['nullable', 'string', 'max:100000'],
            'version' => ['nullable', 'string', 'max:40'],
        ]);

        $version = $data['version'] ?? $this->uniqueVersion($data['audience']);

        // A version name identifies one version of one audience. Publishing the
        // same name twice would break the unique key, so it is refused with a
        // clear message instead of failing halfway through.
        if (TermsVersion::query()
            ->where('audience', $data['audience'])
            ->where('version', $version)
            ->exists()) {
            throw ValidationException::withMessages([
                'version' => ['A version with that name already exists for this audience.'],
            ]);
        }

        $defaultTitles = [
            'common' => 'Common Policies & Terms',
            'privacy' => 'Privacy Policy',
            'student' => 'Student Terms of Service',
            'teacher' => 'Teacher Terms of Service',
            'refund' => 'Refund & Cancellation Policy',
        ];
        $title = trim($data['title'] ?? '');
        if ($title === '') {
            $title = $defaultTitles[$data['audience']] ?? ucfirst(str_replace('_', ' ', $data['audience'])).' Terms';
        }
        $body = $data['body'] ?? '';

        $terms = DB::transaction(function () use ($data, $version, $title, $body, $request): TermsVersion {
            TermsVersion::query()->where('audience', $data['audience'])->update(['is_current' => false]);

            return TermsVersion::query()->create([
                'audience' => $data['audience'],
                'version' => $version,
                'title' => $title,
                'body' => $body,
                'effective_date' => now('Asia/Kolkata')->toDateString(),
                'published_by' => $request->user()->id,
                'published_at' => now(),
                'is_current' => true,
            ]);
        });

        $auditLogger->record(
            $request->user(),
            'terms.published',
            TermsVersion::class,
            $terms->id,
            [],
            ['audience' => $terms->audience, 'version' => $terms->version, 'title' => $terms->title],
        );

        return response()->json(['data' => [
            'id' => $terms->id,
            'audience' => $terms->audience,
            'version' => $terms->version,
            'title' => $terms->title,
            'body' => $terms->body,
            'effective_date' => $terms->effective_date?->toDateString(),
            'published_at' => $terms->published_at?->toIso8601String(),
        ]], 201);
    }

    public function destroy(Request $request, string $audience, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $current = TermsVersion::query()
            ->where('audience', $audience)
            ->where('is_current', true)
            ->first();

        DB::transaction(function () use ($audience) {
            TermsVersion::query()->where('audience', $audience)->update(['is_current' => false]);

            $versionIds = TermsVersion::query()->where('audience', $audience)->pluck('id');
            $hasAcceptances = DB::table('terms_acceptances')
                ->whereIn('terms_version_id', $versionIds)
                ->exists();

            if (! $hasAcceptances) {
                TermsVersion::query()->where('audience', $audience)->delete();
            }
        });

        $auditLogger->record(
            $request->user(),
            'terms.deleted',
            TermsVersion::class,
            $current?->id ?? 0,
            ['audience' => $audience, 'title' => $current?->title ?? ''],
            [],
        );

        return response()->json([
            'message' => 'Terms and conditions removed successfully.',
            'audience' => $audience,
        ]);
    }

    /**
     * A version name that is not taken for this audience yet.
     *
     * Two versions of the same audience can be published in the same second,
     * so the generated name is made unique instead of colliding with the
     * unique key.
     */
    private function uniqueVersion(string $audience): string
    {
        $base = now('Asia/Kolkata')->format('Y.m.d.His');
        $version = $base;
        $suffix = 1;

        while (TermsVersion::query()
            ->where('audience', $audience)
            ->where('version', $version)
            ->exists()) {
            $suffix++;
            $version = $base.'-'.$suffix;
        }

        return $version;
    }
}
