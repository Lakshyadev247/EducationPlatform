<?php

namespace App\Services;

use App\Exceptions\BackupInProgressException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use InvalidArgumentException;
use PDO;
use RuntimeException;
use Throwable;

/**
 * Creates and manages SQL backups of the configured database.
 *
 * The dump is produced with PDO rather than the mysqldump binary, so a backup
 * works on shared hosting where that binary is not installed. The command only
 * reads the configured database and writes into an authorised backup location
 * on the server; it never touches another database.
 */
class DatabaseBackupService
{
    public const DEFAULT_DIRECTORY = '';

    public const DEFAULT_ROOT = BackupDestinationService::INTERNAL_ROOT;

    public const DEFAULT_RETAIN_DAYS = 14;

    public const DEFAULT_SCHEDULE_TIME = '02:00';

    /**
     * The lock that keeps a backup and a restore from running at the same time.
     */
    public const OPERATION_LOCK = 'app:data-operation';

    private const FILE_PATTERN = '/^(?:backup|database-backup|app-backup|backup-)?\d{8}-\d{6}(?:-\d+)?\.sql$/';

    private const ROWS_PER_INSERT = 100;

    public function __construct(
        private readonly SettingsService $settings,
        private readonly BackupDestinationService $destinations,
    ) {}

    /**
     * @return array{root: string, directory: string, destination: string|null, retainDays: int, scheduleEnabled: bool, scheduleTime: string}
     */
    public function settings(): array
    {
        $stored = $this->settings->get('backups', []);
        $stored = is_array($stored) ? $stored : [];

        [$root, $directory] = $this->destinationSetting($stored);

        $retainDays = (int) ($stored['retainDays'] ?? self::DEFAULT_RETAIN_DAYS);
        $scheduleTime = is_string($stored['scheduleTime'] ?? null) ? $stored['scheduleTime'] : self::DEFAULT_SCHEDULE_TIME;

        return [
            'root' => $root,
            'directory' => $directory,
            'destination' => $this->destinationOrNull($root, $directory),
            'retainDays' => max(1, min(365, $retainDays)),
            'scheduleEnabled' => (bool) ($stored['scheduleEnabled'] ?? true),
            'scheduleTime' => $this->isTime($scheduleTime) ? $scheduleTime : self::DEFAULT_SCHEDULE_TIME,
        ];
    }

    /**
     * The absolute folder the backups are written to.
     */
    public function destination(): string
    {
        $settings = $this->settings();

        return $this->destinations->resolve($settings['root'], $settings['directory']);
    }

    /**
     * The absolute folder, or null when the saved choice is no longer valid.
     */
    public function destinationOrNull(?string $root = null, ?string $directory = null): ?string
    {
        $root ??= $this->settings()['root'];
        $directory ??= $this->settings()['directory'];

        try {
            return $this->destinations->resolve($root, $directory);
        } catch (InvalidArgumentException) {
            return null;
        }
    }

    /**
     * The folder tree the Super Admin may pick a destination from.
     *
     * @return array<string, mixed>
     */
    public function browseFolders(string $rootId, string $relative): array
    {
        return $this->destinations->browse($rootId, $relative);
    }

    /**
     * @return array{name: string, path: string, absolute: string, writable: bool}
     */
    public function createFolder(string $rootId, string $relative, string $name): array
    {
        return $this->destinations->createDirectory($rootId, $relative, $name);
    }

    /**
     * @return array{name: string, size: int, created_at: string}
     */
    public function create(): array
    {
        $lock = Cache::lock(self::OPERATION_LOCK, 900);

        if (! $lock->get()) {
            throw new BackupInProgressException;
        }

        try {
            return $this->performCreate();
        } finally {
            $lock->release();
        }
    }

    /**
     * Create a backup while the caller already holds the operation lock.
     *
     * The restore uses this for its safety backup: it holds the lock itself,
     * so a second attempt to take it would fail.
     *
     * @return array{name: string, size: int, created_at: string}
     */
    public function createWithinOperation(): array
    {
        return $this->performCreate();
    }

    /**
     * @return list<array{name: string, size: int, created_at: string}>
     */
    public function list(): array
    {
        $directory = $this->destinationOrNull();

        if ($directory === null || ! is_dir($directory)) {
            return [];
        }

        $backups = [];

        foreach (glob($directory.DIRECTORY_SEPARATOR.'*.sql') ?: [] as $path) {
            $name = basename($path);

            if (preg_match(self::FILE_PATTERN, $name) !== 1 || ! is_file($path)) {
                continue;
            }

            $backups[] = $this->describe($path);
        }

        // Newest first. Sorting by the file's timestamp (not only its name)
        // keeps the retention rule correct when two backups share a second and
        // one received a numeric suffix.
        usort($backups, static function (array $a, array $b): int {
            return strcmp($b['created_at'], $a['created_at']) ?: strcmp($b['name'], $a['name']);
        });

        return $backups;
    }

    public function pathFor(string $name): ?string
    {
        if (preg_match(self::FILE_PATTERN, $name) !== 1) {
            return null;
        }

        $directory = $this->destinationOrNull();

        if ($directory === null) {
            return null;
        }

        $path = $directory.DIRECTORY_SEPARATOR.$name;

        if (! is_file($path)) {
            return null;
        }

        // The file must still be inside the authorised folder.
        $real = realpath($path);
        $realDirectory = realpath($directory);

        if ($real === false || $realDirectory === false || ! str_starts_with($real, $realDirectory.DIRECTORY_SEPARATOR)) {
            return null;
        }

        return $real;
    }

    public function delete(string $name): bool
    {
        $path = $this->pathFor($name);

        if ($path === null) {
            return false;
        }

        return unlink($path);
    }

    public function prune(?int $retainDays = null): int
    {
        $days = $retainDays ?? $this->settings()['retainDays'];
        $backups = $this->list();

        // Always keep the newest backup, even when every file is older than the
        // retention window. An empty backup folder is worse than a stale one.
        if (count($backups) <= 1) {
            return 0;
        }

        $cutoff = now()->subDays($days)->getTimestamp();
        $deleted = 0;

        foreach (array_slice($backups, 1) as $backup) {
            $path = $this->pathFor($backup['name']);

            if ($path === null) {
                continue;
            }

            if (filemtime($path) < $cutoff && @unlink($path)) {
                $deleted++;
            }
        }

        return $deleted;
    }

    public function hasBackupOn(string $date): bool
    {
        $prefix = 'backup-'.str_replace('-', '', $date).'-';

        foreach ($this->list() as $backup) {
            if (str_starts_with($backup['name'], $prefix)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The scheduler runs hourly. A backup is due at the configured time, or at
     * the first hourly run after it when the server was unavailable at that
     * minute, and only once per calendar day.
     */
    public function isScheduleDue(): bool
    {
        $settings = $this->settings();

        if (! $settings['scheduleEnabled']) {
            return false;
        }

        $now = now();

        if ($now->format('H:i') < $settings['scheduleTime']) {
            return false;
        }

        return ! $this->hasBackupOn($now->toDateString());
    }

    /**
     * True when a file looks like a complete dump this application wrote.
     *
     * The head and the tail are checked; the file is never loaded into memory
     * only to be thrown away again.
     */
    public function isVerifiedDump(string $path): bool
    {
        if (! is_file($path)) {
            return false;
        }

        $size = filesize($path);

        if ($size === false || $size < 64) {
            return false;
        }

        $handle = fopen($path, 'rb');

        if ($handle === false) {
            return false;
        }

        $head = (string) fread($handle, 4096);
        fseek($handle, max(0, $size - 4096), SEEK_SET);
        $tail = (string) fread($handle, 4096);
        fclose($handle);

        $hasHeader = str_contains($head, 'Database backup')
            || str_contains($head, 'MySQL dump');

        $hasFooter = str_contains($tail, 'Dump completed');

        return $hasHeader && $hasFooter;
    }

    /**
     * @return array{name: string, size: int, created_at: string}
     */
    private function performCreate(): array
    {
        $settings = $this->settings();

        try {
            $directory = $this->destinations->resolve($settings['root'], $settings['directory']);
        } catch (InvalidArgumentException $exception) {
            throw new RuntimeException('The backup destination is not usable: '.$exception->getMessage(), 0, $exception);
        }

        if (! is_dir($directory)) {
            File::ensureDirectoryExists($directory);
        }

        if (! is_writable($directory)) {
            throw new RuntimeException('The backup folder "'.$directory.'" is not writable by the web server.');
        }

        $path = $directory.DIRECTORY_SEPARATOR.$this->nextName($directory);
        $handle = fopen($path, 'wb');

        if ($handle === false) {
            throw new RuntimeException('The backup file could not be created.');
        }

        try {
            $this->writeDump($handle);
        } catch (Throwable $exception) {
            fclose($handle);
            @unlink($path);

            throw new RuntimeException('The database backup failed: '.$exception->getMessage(), 0, $exception);
        }

        fclose($handle);

        if (! is_file($path) || filesize($path) === 0) {
            @unlink($path);

            throw new RuntimeException('The database backup was empty.');
        }

        $this->prune($settings['retainDays']);

        return $this->describe($path);
    }

    /**
     * Read the destination choice, keeping older settings working.
     *
     * Before the destination became a root plus a relative folder, the value
     * was a folder below storage/app that always started with "backups".
     *
     * @param  array<string, mixed>  $stored
     * @return array{0: string, 1: string}
     */
    private function destinationSetting(array $stored): array
    {
        $root = self::DEFAULT_ROOT;
        $directory = '';

        if (isset($stored['root']) && is_string($stored['root']) && $this->destinations->hasRoot($stored['root'])) {
            $root = $stored['root'];
            $directory = is_string($stored['directory'] ?? null) ? $stored['directory'] : '';
        } elseif (isset($stored['directory']) && is_string($stored['directory'])) {
            $legacy = trim(str_replace('\\', '/', $stored['directory']), '/');

            $directory = match (true) {
                $legacy === 'backups' => '',
                str_starts_with($legacy, 'backups/') => substr($legacy, 8),
                default => '',
            };
        }

        try {
            $this->destinations->resolve($root, $directory);
        } catch (InvalidArgumentException) {
            $directory = '';
        }

        return [$root, trim(str_replace('\\', '/', $directory), '/')];
    }

    private function isTime(string $time): bool
    {
        return preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $time) === 1;
    }

    private function nextName(string $directory): string
    {
        $base = 'backup-'.now()->format('Ymd-His');
        $name = $base.'.sql';
        $suffix = 1;

        while (file_exists($directory.DIRECTORY_SEPARATOR.$name)) {
            $suffix++;
            $name = $base.'-'.$suffix.'.sql';
        }

        return $name;
    }

    /**
     * @return array{name: string, size: int, created_at: string}
     */
    private function describe(string $path): array
    {
        return [
            'name' => basename($path),
            'size' => (int) filesize($path),
            'created_at' => date(DATE_ATOM, (int) filemtime($path)),
        ];
    }

    /**
     * @param  resource  $handle
     */
    private function writeDump($handle): void
    {
        $connection = DB::connection();
        $pdo = $connection->getPdo();
        $database = (string) $connection->getDatabaseName();

        $write = static function (string $line) use ($handle): void {
            fwrite($handle, $line."\n");
        };

        $write('-- Database backup');
        $write('-- Database: '.$database);
        $write('-- Generated: '.now()->toIso8601String());
        $write('-- Restore with the mysql client. This file drops and recreates every table.');
        $write('');
        $write('SET NAMES utf8mb4;');
        $write('SET FOREIGN_KEY_CHECKS=0;');
        $write('SET UNIQUE_CHECKS=0;');
        $write('');

        $tables = $pdo->query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")->fetchAll(PDO::FETCH_NUM);

        foreach ($tables as $tableRow) {
            $table = (string) $tableRow[0];
            $quotedTable = $this->quoteIdentifier($table);
            $createRow = $pdo->query('SHOW CREATE TABLE '.$quotedTable)->fetch(PDO::FETCH_NUM);
            $createSql = isset($createRow[1]) ? (string) $createRow[1] : '';

            if ($createSql === '') {
                throw new RuntimeException('The schema for '.$table.' could not be read.');
            }

            $write('-- Table '.$table);
            $write('DROP TABLE IF EXISTS '.$quotedTable.';');
            $write($createSql.';');
            $write('');

            $statement = $pdo->query('SELECT * FROM '.$quotedTable);
            $batch = [];
            $columns = [];

            $flush = function () use (&$batch, &$columns, $pdo, $quotedTable, $write): void {
                if ($batch === []) {
                    return;
                }

                $columnList = implode(', ', array_map($this->quoteIdentifier(...), $columns));
                $tuples = [];

                foreach ($batch as $row) {
                    $values = [];

                    foreach ($columns as $column) {
                        $value = $row[$column] ?? null;

                        if ($value === null) {
                            $values[] = 'NULL';
                        } elseif (is_int($value) || is_float($value)) {
                            $values[] = (string) $value;
                        } else {
                            $values[] = $pdo->quote((string) $value);
                        }
                    }

                    $tuples[] = '('.implode(', ', $values).')';
                }

                $write('INSERT INTO '.$quotedTable.' ('.$columnList.') VALUES '.implode(', ', $tuples).';');

                $batch = [];
            };

            while ($row = $statement->fetch(PDO::FETCH_ASSOC)) {
                if ($columns === []) {
                    $columns = array_keys($row);
                }

                $batch[] = $row;

                if (count($batch) >= self::ROWS_PER_INSERT) {
                    $flush();
                }
            }

            $flush();
            $write('');
        }

        $write('SET FOREIGN_KEY_CHECKS=1;');
        $write('SET UNIQUE_CHECKS=1;');
        $write('');
        $write('-- Dump completed');
    }

    private function quoteIdentifier(string $identifier): string
    {
        return '`'.str_replace('`', '``', $identifier).'`';
    }
}
