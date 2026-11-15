<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Services\AuditLogger;
use App\Services\BackupDestinationService;
use App\Services\BrandingUrlValidator;
use App\Services\SettingSchema;
use App\Services\SettingsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

class SettingController extends Controller
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly SettingSchema $schema,
        private readonly BrandingUrlValidator $brandingUrls,
        private readonly BackupDestinationService $destinations,
    ) {}

    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        return response()->json(['data' => $this->settings->all()]);
    }

    public function update(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $data = $request->validate([
            'settings' => ['required', 'array'],
            'settings.*' => ['required', 'array'],
        ]);

        $groups = array_keys($data['settings']);

        $unknownGroups = array_values(array_diff($groups, $this->schema->groupNames()));
        if ($unknownGroups !== []) {
            abort(422, 'Unknown settings group: '.implode(', ', $unknownGroups));
        }

        foreach ($groups as $group) {
            if ($this->schema->isReadOnly($group)) {
                abort(422, sprintf(
                    'The "%s" settings are maintained by their own endpoint and cannot be edited here.',
                    $group
                ));
            }
        }

        // Backup settings decide where full copies of the database are written
        // and how long they are kept, so only a Super Admin may change them.
        if (in_array('backups', $groups, true) && ! $request->user()->isSuperAdmin()) {
            abort(403, 'Only a Super Admin can change the backup settings.');
        }

        // Laravel's ConvertEmptyStringsToNull middleware turns an empty string in
        // the request into null, but the schema declares these keys as text.
        // A field an administrator left empty is an empty string, not a missing
        // value, so the empty strings are restored before the group is checked.
        // Without this the contact and branding panels can never be saved:
        // both hold text fields that are empty by default.
        foreach ($groups as $group) {
            foreach ($this->schema->textKeys($group) as $key) {
                if (array_key_exists($key, $data['settings'][$group]) && $data['settings'][$group][$key] === null) {
                    $data['settings'][$group][$key] = '';
                }
            }
        }

        // Every key must be known and every value must have the type and range
        // the schema declares. A setting the server cannot act on can no
        // longer be stored, so a control that does nothing cannot be shown
        // as if it did something.
        $rules = [];
        foreach ($groups as $group) {
            $unknownKeys = $this->schema->unknownKeys($group, $data['settings'][$group]);

            if ($unknownKeys !== []) {
                throw ValidationException::withMessages([
                    'settings.'.$group => ['Unknown setting: '.implode(', ', $unknownKeys).'.'],
                ]);
            }

            $rules = array_merge($rules, $this->schema->rulesFor($group));
        }

        if ($rules !== []) {
            // The rules are checked against the group as it was received, with
            // the empty text fields restored, so a value an administrator left
            // empty is stored as an empty string.
            Validator::make($data, $rules)->validate();
        }

        if (isset($data['settings']['backups']['root']) || isset($data['settings']['backups']['directory'])) {
            $root = trim((string) ($data['settings']['backups']['root'] ?? ''));
            $directory = trim(str_replace('\\', '/', (string) ($data['settings']['backups']['directory'] ?? '')));

            if ($root === '') {
                $root = BackupDestinationService::INTERNAL_ROOT;
            }

            if (! $this->destinations->hasRoot($root)) {
                throw ValidationException::withMessages([
                    'settings.backups.root' => 'Choose one of the backup locations configured on this server.',
                ]);
            }

            try {
                $this->destinations->resolve($root, $directory);
            } catch (InvalidArgumentException $exception) {
                throw ValidationException::withMessages([
                    'settings.backups.directory' => $exception->getMessage(),
                ]);
            }

            $data['settings']['backups']['root'] = $root;
            $data['settings']['backups']['directory'] = $directory;
        }

        // The branding image references are echoed to EVERY visitor by
        // /api/v1/meta and rendered by the frontend, so they are restricted to
        // the application's own upload directory. A value such as a data: URL,
        // a javascript: URL or markup is refused before a single row is
        // written, so a stored value can never become markup in a browser.
        if (isset($data['settings']['branding'])) {
            $this->validateBrandingImages($data['settings']['branding']);
        }

        $old = $this->settings->all();
        $this->settings->putGroups($data['settings'], $request->user());

        foreach ($data['settings'] as $group => $value) {
            $auditLogger->record(
                $request->user(),
                'settings.updated',
                Setting::class,
                $group,
                ['value' => $this->safeForAudit($group, $old[$group] ?? null)],
                ['value' => $this->safeForAudit($group, $value)],
            );
        }

        return response()->json(['data' => $this->settings->all()]);
    }

    private function safeForAudit(string $group, mixed $value): mixed
    {
        if ($group !== 'branding' || ! is_array($value)) {
            return $value;
        }

        return [
            'appName' => $value['appName'] ?? null,
            'tagline' => $value['tagline'] ?? null,
            'logo' => isset($value['logo']) ? '[stored image]' : null,
            'logo2' => isset($value['logo2']) ? '[stored image]' : null,
            'favicon' => isset($value['favicon']) ? '[stored image]' : null,
        ];
    }

    /**
     * Accept only image references that live in the application's own public
     * upload directory. The upload endpoint writes exactly that shape, so a
     * legitimate value is never rejected.
     *
     * @param  array<string, mixed>  $branding
     */
    private function validateBrandingImages(array $branding): void
    {
        foreach ($this->brandingUrls->refusedSlots($branding) as $slot) {
            throw ValidationException::withMessages([
                'settings.branding.'.$slot => ['Use an image from the application upload directory.'],
            ]);
        }
    }
}
