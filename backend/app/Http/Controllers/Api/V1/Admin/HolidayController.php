<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\PlatformHoliday;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class HolidayController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        return response()->json([
            'data' => PlatformHoliday::query()->orderBy('holiday_date')->get()->map(fn ($holiday): array => [
                'id' => $holiday->id,
                'date' => $holiday->holiday_date?->toDateString(),
                'label' => $holiday->name,
                'description' => $holiday->description,
            ])->values(),
        ]);
    }

    public function store(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'date' => ['required', 'date_format:Y-m-d', Rule::unique('platform_holidays', 'holiday_date')],
            'label' => ['required', 'string', 'max:120'],
            'description' => ['nullable', 'string', 'max:255'],
        ]);

        $holiday = PlatformHoliday::query()->create([
            'holiday_date' => $data['date'],
            'name' => trim($data['label']),
            'description' => $data['description'] ?? null,
            'created_by' => $request->user()->id,
        ]);

        $auditLogger->record(
            $request->user(),
            'holiday.created',
            PlatformHoliday::class,
            $holiday->id,
            [],
            ['date' => $data['date'], 'label' => $data['label']],
        );

        return response()->json(['data' => [
            'id' => $holiday->id,
            'date' => $holiday->holiday_date?->toDateString(),
            'label' => $holiday->name,
        ]], 201);
    }

    public function destroy(Request $request, PlatformHoliday $holiday, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $auditLogger->record(
            $request->user(),
            'holiday.deleted',
            PlatformHoliday::class,
            $holiday->id,
            ['date' => $holiday->holiday_date?->toDateString(), 'label' => $holiday->name],
            [],
        );

        $holiday->delete();

        return response()->json(['message' => 'Holiday removed.']);
    }
}
