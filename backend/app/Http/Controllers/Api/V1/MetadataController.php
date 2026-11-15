<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\EducationLevel;
use App\Models\Stream;
use App\Models\Subject;
use App\Models\TermsVersion;
use App\Services\SettingsService;
use Illuminate\Http\JsonResponse;

class MetadataController extends Controller
{
    public function __construct(private readonly SettingsService $settings) {}

    public function index(): JsonResponse
    {
        return response()->json([
            'data' => [
                'subjects' => Subject::query()
                    ->where('is_active', true)
                    ->orderBy('sort_order')
                    ->get(['id', 'name', 'slug']),
                'levels' => EducationLevel::query()
                    ->where('is_active', true)
                    ->orderBy('sort_order')
                    ->get(['id', 'key', 'label']),
                'streams' => Stream::query()
                    ->where('is_active', true)
                    ->orderBy('sort_order')
                    ->get(['id', 'key', 'label']),
                'settings' => $this->settings->publicSettings(),
                'terms' => TermsVersion::query()
                    ->where('is_current', true)
                    ->orderBy('audience')
                    ->get(['audience', 'version', 'title', 'body', 'effective_date', 'published_at']),
            ],
        ]);
    }
}
