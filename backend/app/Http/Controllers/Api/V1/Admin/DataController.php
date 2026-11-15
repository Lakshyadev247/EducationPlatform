<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Exceptions\BackupInProgressException;
use App\Exceptions\RestoreException;
use App\Http\Controllers\Controller;
use App\Services\AuditLogger;
use App\Services\BackupDestinationService;
use App\Services\DatabaseBackupService;
use App\Services\DatabaseBrowserService;
use App\Services\DatabaseRestoreService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

class DataController extends Controller
{
    public function __construct(
        private readonly DatabaseBackupService $backups,
        private readonly DatabaseBrowserService $browser,
        private readonly DatabaseRestoreService $restore,
        private readonly BackupDestinationService $destinations,
    ) {}

    public function overview(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        return response()->json([
            'data' => [
                'connection' => $this->browser->connection(),
                'tables' => $this->browser->tables(),
                'backups' => $this->backups->list(),
                'settings' => $this->backups->settings(),
                'roots' => $this->destinations->roots(),
                'restore' => $this->restore->capability(),
            ],
        ]);
    }

    public function folders(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $validated = $request->validate([
            'root' => ['sometimes', 'nullable', 'string', 'max:60'],
            'path' => ['sometimes', 'nullable', 'string', 'max:255'],
        ]);

        try {
            $folder = $this->backups->browseFolders(
                (string) ($validated['root'] ?? BackupDestinationService::INTERNAL_ROOT),
                (string) ($validated['path'] ?? '')
            );
        } catch (InvalidArgumentException $exception) {
            throw ValidationException::withMessages(['path' => $exception->getMessage()]);
        }

        return response()->json(['data' => $folder]);
    }

    public function createFolder(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $validated = $request->validate([
            'root' => ['sometimes', 'nullable', 'string', 'max:60'],
            'parent' => ['sometimes', 'nullable', 'string', 'max:255'],
            'name' => ['required', 'string', 'max:60'],
        ]);

        try {
            $folder = $this->backups->createFolder(
                (string) ($validated['root'] ?? BackupDestinationService::INTERNAL_ROOT),
                (string) ($validated['parent'] ?? ''),
                (string) $validated['name'],
            );
        } catch (InvalidArgumentException $exception) {
            throw ValidationException::withMessages(['name' => $exception->getMessage()]);
        }

        $auditLogger->record(
            $request->user(),
            'data.folder.created',
            'backup_folder',
            $folder['path'],
            [],
            ['path' => $folder['path'], 'location' => $folder['absolute']],
        );

        return response()->json(['data' => $folder], 201);
    }

    public function rows(Request $request, string $table, AuditLogger $auditLogger): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $validated = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
        ]);

        $page = (int) ($validated['page'] ?? 1);
        $perPage = (int) ($validated['per_page'] ?? 25);
        $search = (string) ($validated['q'] ?? '');

        $result = $this->browser->rows($table, $page, $perPage, $search);

        $auditLogger->record(
            $request->user(),
            'data.table.viewed',
            'database_table',
            $table,
            [],
            [
                'page' => $result['meta']['page'],
                'per_page' => $result['meta']['per_page'],
                'filtered' => $search !== '',
            ],
        );

        return response()->json(['data' => $result]);
    }

    public function backup(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        try {
            $backup = $this->backups->create();
        } catch (BackupInProgressException $exception) {
            abort(409, $exception->getMessage());
        }

        $auditLogger->record(
            $request->user(),
            'backup.created',
            'database_backup',
            $backup['name'],
            [],
            ['name' => $backup['name'], 'size' => $backup['size']],
        );

        return response()->json(['data' => $backup], 201);
    }

    /**
     * Create a backup and send it straight to the administrator's browser.
     *
     * The file is written on the server first and then handed to the browser,
     * which lets the administrator save it wherever they want it on their own
     * computer.
     */
    public function downloadBackup(Request $request, AuditLogger $auditLogger): BinaryFileResponse
    {
        $this->authoriseSuperAdmin($request);

        try {
            $backup = $this->backups->create();
        } catch (BackupInProgressException $exception) {
            abort(409, $exception->getMessage());
        }

        $path = $this->backups->pathFor($backup['name']);

        abort_if($path === null, 500, 'The backup file could not be read.');

        $auditLogger->record(
            $request->user(),
            'backup.downloaded',
            'database_backup',
            $backup['name'],
            [],
            ['name' => $backup['name'], 'size' => $backup['size'], 'delivered' => 'browser'],
        );

        return response()->download($path, $backup['name'], ['Content-Type' => 'application/sql']);
    }

    public function download(Request $request, string $file, AuditLogger $auditLogger): BinaryFileResponse
    {
        $this->authoriseSuperAdmin($request);

        $path = $this->backups->pathFor($file);
        abort_if($path === null, 404);

        $auditLogger->record(
            $request->user(),
            'backup.downloaded',
            'database_backup',
            $file,
        );

        return response()->download($path, $file, ['Content-Type' => 'application/sql']);
    }

    public function destroy(Request $request, string $file, AuditLogger $auditLogger): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        abort_unless($this->backups->delete($file), 404);

        $auditLogger->record(
            $request->user(),
            'backup.deleted',
            'database_backup',
            $file,
        );

        return response()->json(['data' => ['deleted' => true]]);
    }

    /**
     * Hand out the single-use token a restore request has to carry.
     */
    public function restoreToken(Request $request): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $capability = $this->restore->capability();

        abort_if(! $capability['allowed'], 403, (string) $capability['reason']);

        return response()->json(['data' => $this->restore->issueToken((int) $request->user()->id)]);
    }

    /**
     * Restore a dump into the configured database.
     */
    public function restore(Request $request, AuditLogger $auditLogger): JsonResponse
    {
        $this->authoriseSuperAdmin($request);

        $capability = $this->restore->capability();

        abort_if(! $capability['allowed'], 403, (string) $capability['reason']);

        $maxKilobytes = (int) ceil(((int) config('backup.max_upload_bytes', 52428800)) / 1024);

        $validated = $request->validate([
            'confirmation' => ['required', 'string', 'max:20'],
            'token' => ['required', 'string', 'size:64'],
            'source' => ['required', 'string', 'in:upload,server'],
            'file' => ['sometimes', 'nullable', 'string', 'max:255'],
            'dump' => ['sometimes', 'file', 'max:'.$maxKilobytes],
        ]);

        if ($validated['confirmation'] !== DatabaseRestoreService::CONFIRMATION) {
            throw ValidationException::withMessages([
                'confirmation' => 'Type RESTORE to confirm that the database may be replaced.',
            ]);
        }

        if (! $this->restore->consumeToken((int) $request->user()->id, (string) $validated['token'])) {
            throw ValidationException::withMessages([
                'token' => 'This confirmation has expired. Start the restore again.',
            ]);
        }

        $source = (string) $validated['source'];
        $temporary = null;
        $name = '';
        $path = null;

        try {
            if ($source === 'upload') {
                $uploaded = $request->file('dump');

                if (! $uploaded || ! $uploaded->isValid()) {
                    throw ValidationException::withMessages(['dump' => 'Choose a database dump to restore.']);
                }

                $name = basename((string) $uploaded->getClientOriginalName());
                $temporary = $this->storeUploadedDump($uploaded);
                $path = $temporary;
            } else {
                $name = basename((string) ($validated['file'] ?? ''));
                $path = $this->backups->pathFor($name);

                if ($path === null) {
                    throw ValidationException::withMessages([
                        'file' => 'That backup file is not in the backup folder.',
                    ]);
                }
            }

            $auditLogger->record(
                $request->user(),
                'data.restore.started',
                'database_restore',
                $name,
                [],
                [
                    'database' => $capability['database'],
                    'source' => $source,
                    'started_at' => now()->toIso8601String(),
                ],
            );

            $result = $this->restore->restore($path, $name, $source);

            $auditLogger->record(
                $request->user(),
                'data.restore.completed',
                'database_restore',
                $name,
                [],
                [
                    'database' => $result['database'],
                    'source' => $source,
                    'tables' => $result['tables'],
                    'rows' => $result['rows'],
                    'safety_backup' => $result['safety_backup'],
                    'started_at' => $result['started_at'],
                    'finished_at' => $result['finished_at'],
                ],
            );

            return response()->json(['data' => $result]);
        } catch (BackupInProgressException $exception) {
            return response()->json([
                'message' => $exception->getMessage(),
                'reason' => 'busy',
            ], 409);
        } catch (RestoreException $exception) {
            $auditLogger->record(
                $request->user(),
                'data.restore.failed',
                'database_restore',
                $name,
                [],
                [
                    'database' => $capability['database'],
                    'source' => $source,
                    'outcome' => 'failed',
                    'reason' => $exception->reason(),
                    'detail' => Str::limit($exception->getMessage(), 240, ''),
                ],
            );

            return response()->json([
                'message' => $exception->getMessage(),
                'reason' => $exception->reason(),
            ], 422);
        } finally {
            if ($temporary !== null && is_file($temporary)) {
                @unlink($temporary);
            }
        }
    }

    private function authoriseSuperAdmin(Request $request): void
    {
        abort_unless($request->user()->isSuperAdmin(), 403);
    }

    /**
     * Move an uploaded dump into the private storage area for the time it is
     * being restored.
     */
    private function storeUploadedDump(UploadedFile $uploaded): string
    {
        $directory = storage_path('app/private/restore');

        File::ensureDirectoryExists($directory);

        $name = 'restore-'.Str::random(40).'.sql';
        $uploaded->move($directory, $name);

        return $directory.DIRECTORY_SEPARATOR.$name;
    }
}
