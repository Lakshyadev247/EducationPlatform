<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

/**
 * Branding image uploads.
 *
 * The branding group already stored image *references*; there was no endpoint
 * that accepted an image, so nothing validated type, size or dimensions
 * server-side. This adds one.
 *
 * Safety rules:
 *  * validation runs before anything is written, so a rejected upload leaves the
 *    existing logo completely untouched;
 *  * storage failure is caught and reported, again leaving the current logo in
 *    place;
 *  * only the stored path is written into settings — never the raw upload.
 */
class BrandingController extends Controller
{
    /** slot => [max kilobytes, max width, max height] */
    private const SLOTS = [
        'logo' => [2048, 2000, 2000],
        'logo2' => [2048, 2000, 2000],
        'favicon' => [512, 512, 512],
    ];

    public function upload(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'slot' => ['required', Rule::in(array_keys(self::SLOTS))],
            'image' => ['required', 'file', 'image', 'mimes:jpg,jpeg,png,webp', 'max:2048'],
        ]);

        $slot = $data['slot'];
        [$maxKb, $maxW, $maxH] = self::SLOTS[$slot];

        // Dimension check. getimagesize() reads the header only.
        $info = @getimagesize($request->file('image')->getRealPath());
        if ($info === false) {
            return response()->json(['message' => 'That file is not a readable image.'], 422);
        }

        [$width, $height] = $info;
        if ($width > $maxW || $height > $maxH) {
            return response()->json([
                'message' => "That image is {$width}×{$height}. The maximum for the {$slot} is {$maxW}×{$maxH}.",
            ], 422);
        }

        $setting = Setting::query()->where('key', 'branding')->first();
        $current = is_array($setting?->value) ? $setting->value : [];
        $previous = $current[$slot] ?? null;

        try {
            $path = $request->file('image')->store('branding', 'public');
        } catch (\Throwable $e) {
            // Nothing has been written to settings, so the existing logo stands.
            return response()->json([
                'message' => 'The image could not be stored. The existing branding was left unchanged.',
            ], 500);
        }

        $url = Storage::disk('public')->url($path);

        DB::transaction(function () use ($setting, $current, $slot, $url, $request, $auditLogger, $previous): void {
            $next = $current;
            $next[$slot] = $url;

            if ($setting === null) {
                Setting::query()->create(['key' => 'branding', 'group' => 'branding', 'type' => 'json', 'value' => $next, 'updated_by' => $request->user()->id]);
            } else {
                $setting->value = $next;
                $setting->updated_by = $request->user()->id;
                $setting->save();
            }

            $auditLogger->record($request->user(), 'branding.upload', Setting::class, null,
                [$slot => $previous], [$slot => $url]);
        });

        // Only now is the old file removed, and only if it was a managed upload.
        if (is_string($previous) && $previous !== $url && str_contains($previous, '/storage/branding/')) {
            $oldRelative = 'branding/'.basename($previous);
            if (Storage::disk('public')->exists($oldRelative)) {
                Storage::disk('public')->delete($oldRelative);
            }
        }

        return response()->json(['data' => ['slot' => $slot, 'url' => $url]]);
    }

    /** Reset one slot to the built-in default without touching the others. */
    public function reset(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate(['slot' => ['required', Rule::in(array_keys(self::SLOTS))]]);

        $setting = Setting::query()->where('key', 'branding')->first();
        $current = is_array($setting?->value) ? $setting->value : [];
        $previous = $current[$data['slot']] ?? null;

        $current[$data['slot']] = null;

        if ($setting !== null) {
            $setting->value = $current;
            $setting->updated_by = $request->user()->id;
            $setting->save();
        }

        $auditLogger->record($request->user(), 'branding.reset', Setting::class, null,
            [$data['slot'] => $previous], [$data['slot'] => null]);

        return response()->json(['data' => ['slot' => $data['slot'], 'url' => null]]);
    }
}
