<?php

namespace App\Services;

use App\Exceptions\BackupInProgressException;
use App\Exceptions\RestoreException;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Restores a database dump into the server's configured database.
 *
 * The rules are deliberately narrow:
 *
 *  - only a Super Admin may ask for a restore;
 *  - the target is always the database the application is configured to use,
 *    never one named by the request;
 *  - the target must be a disposable, non-production database;
 *  - the file is validated by its contents, not by its name;
 *  - a safety backup is written and verified before anything is replaced;
 *  - the dump is executed through the application's own database connection,
 *    never through a shell command;
 *  - the result is verified against the dump before it is reported as a
 *    success.
 */
class DatabaseRestoreService
{
    public const CONFIRMATION = 'RESTORE';

    private const TOKEN_TTL = 300;

    /**
     * Statements that must never be executed from an uploaded dump.
     *
     * @var list<string>
     */
    private const FORBIDDEN_STATEMENTS = [
        '/\bCREATE\s+(USER|DATABASE|SCHEMA|ROLE|FUNCTION|PROCEDURE|TRIGGER|EVENT|VIEW)\b/i',
        '/\bALTER\s+USER\b/i',
        '/\bDROP\s+(DATABASE|SCHEMA)\b/i',
        '/\bGRANT\b/i',
        '/\bREVOKE\b/i',
        '/\bLOAD\s+DATA\b/i',
        '/\bLOAD_FILE\s*\(/i',
        '/\bINTO\s+(OUTFILE|DUMPFILE)\b/i',
        '/\bSET\s+(GLOBAL|PASSWORD)\b/i',
    ];

    public function __construct(
        private readonly Application $app,
        private readonly DatabaseBackupService $backups,
        private readonly DatabaseGuard $guard,
    ) {}

    /**
     * Whether a restore may be run against the connected database.
     *
     * @return array{allowed: bool, reason: string|null, database: string}
     */
    public function capability(): array
    {
        $database = $this->targetDatabase();

        if ($this->app->environment() === 'production') {
            return [
                'allowed' => false,
                'reason' => 'Restore is disabled in production. Restoring a dump replaces the live data of "'
                    .$database.'".',
                'database' => $database,
            ];
        }

        if (! $this->guard->isDisposable($database)) {
            return [
                'allowed' => false,
                'reason' => 'Restore only runs against a disposable test database. The connected database "'
                    .$database.'" is protected, so restoring is refused.',
                'database' => $database,
            ];
        }

        return [
            'allowed' => true,
            'reason' => null,
            'database' => $database,
        ];
    }

    /**
     * A single-use token that has to travel with the restore request.
     *
     * @return array{token: string, expires_at: string}
     */
    public function issueToken(int $userId): array
    {
        $token = Str::random(64);

        Cache::put($this->tokenKey($userId), $token, self::TOKEN_TTL);

        return [
            'token' => $token,
            'expires_at' => now()->addSeconds(self::TOKEN_TTL)->toIso8601String(),
        ];
    }

    /**
     * Spend the token. A token works once, which stops a captured request
     * from being replayed.
     */
    public function consumeToken(int $userId, string $token): bool
    {
        $key = $this->tokenKey($userId);
        $stored = Cache::get($key);

        if (! is_string($stored) || ! hash_equals($stored, $token)) {
            return false;
        }

        Cache::forget($key);

        return true;
    }

    /**
     * Restore a dump into the configured database.
     *
     * @return array<string, mixed>
     */
    public function restore(string $dumpPath, string $fileName, string $source): array
    {
        $capability = $this->capability();

        if (! $capability['allowed']) {
            throw new RestoreException((string) $capability['reason'], 'not_allowed');
        }

        $lock = Cache::lock(DatabaseBackupService::OPERATION_LOCK, 900);

        if (! $lock->get()) {
            throw new BackupInProgressException;
        }

        try {
            return $this->performRestore($dumpPath, $fileName, $source);
        } finally {
            $lock->release();
        }
    }

    /**
     * Check a dump file before anything is executed.
     *
     * @return array{tables: list<string>, statements: list<string>, rows: array<string, int>, size: int}
     */
    public function validateDump(string $path): array
    {
        $maxBytes = (int) config('backup.max_upload_bytes', 52428800);
        $size = filesize($path);

        if ($size === false || $size === 0) {
            throw new RestoreException('The backup file is empty.', 'empty_file');
        }

        if ($size > $maxBytes) {
            throw new RestoreException(
                'The backup file is larger than the '.round($maxBytes / 1048576).' MB limit for a restore.',
                'too_large'
            );
        }

        $sql = file_get_contents($path);

        if ($sql === false) {
            throw new RestoreException('The backup file could not be read.', 'unreadable');
        }

        if (str_contains($sql, "\0")) {
            throw new RestoreException('That file is not a text database dump.', 'not_a_dump');
        }

        if (! mb_check_encoding($sql, 'UTF-8')) {
            throw new RestoreException('That file is not a text database dump.', 'not_a_dump');
        }

        foreach (self::FORBIDDEN_STATEMENTS as $pattern) {
            if (preg_match($pattern, $sql) === 1) {
                throw new RestoreException(
                    'That dump contains statements that are not allowed in a restore.',
                    'forbidden_statement'
                );
            }
        }

        if (! preg_match('/\bCREATE\s+TABLE\b/i', $sql)) {
            throw new RestoreException('That file does not contain any CREATE TABLE statement.', 'not_a_dump');
        }

        if (! str_contains($sql, 'Dump completed')) {
            throw new RestoreException('That dump looks incomplete: it has no end marker.', 'incomplete_dump');
        }

        $statements = $this->splitStatements($sql);

        if ($statements === []) {
            throw new RestoreException('That file does not contain any SQL statement.', 'not_a_dump');
        }

        $tables = [];

        foreach ($statements as $statement) {
            if (preg_match('/^CREATE\s+TABLE\s+`?([A-Za-z0-9_]+)`?/i', $statement, $matches) === 1) {
                $tables[] = $matches[1];
            }
        }

        return [
            'tables' => array_values(array_unique($tables)),
            'statements' => $statements,
            'rows' => $this->expectedRowCounts($statements),
            'size' => (int) $size,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function performRestore(string $dumpPath, string $fileName, string $source): array
    {
        $dump = $this->validateDump($dumpPath);
        $startedAt = now();

        try {
            $safety = $this->backups->createWithinOperation();
        } catch (Throwable $exception) {
            Log::error('Database restore aborted: the safety backup failed.', [
                'file' => $fileName,
                'exception' => $exception,
            ]);

            throw new RestoreException(
                'The safety backup could not be created, so the restore was not started.',
                'safety_backup_failed',
                [],
                $exception
            );
        }

        $safetyPath = $this->backups->pathFor($safety['name']);

        if ($safetyPath === null || ! $this->backups->isVerifiedDump($safetyPath)) {
            throw new RestoreException(
                'The safety backup could not be verified, so the restore was not started.',
                'safety_backup_failed',
                ['safety_backup' => $safety['name']]
            );
        }

        try {
            $this->execute($dump['statements']);
        } catch (Throwable $exception) {
            $recovery = $this->recover($safetyPath);

            Log::error('Database restore failed.', [
                'file' => $fileName,
                'recovered' => $recovery['ok'],
                'exception' => $exception,
            ]);

            throw new RestoreException(
                'The restore failed. '.(($recovery['ok'])
                    ? 'The database was put back to its state before the restore.'
                    : 'The automatic recovery did not finish. Use the safety backup "'.$safety['name'].'" to restore it by hand.'),
                'execution_failed',
                ['safety_backup' => $safety['name'], 'recovered' => $recovery['ok']],
                $exception
            );
        }

        $verification = $this->verify($dump);

        if (! $verification['ok']) {
            $recovery = $this->recover($safetyPath);

            throw new RestoreException(
                'The restore did not pass verification. '.(($recovery['ok'])
                    ? 'The database was put back to its state before the restore.'
                    : 'The automatic recovery did not finish. Use the safety backup "'.$safety['name'].'" to restore it by hand.'),
                'verification_failed',
                ['safety_backup' => $safety['name'], 'verification' => $verification]
            );
        }

        return [
            'database' => $this->targetDatabase(),
            'file' => $fileName,
            'source' => $source,
            'tables' => count($dump['tables']),
            'rows' => array_sum($dump['rows']),
            'safety_backup' => $safety['name'],
            'started_at' => $startedAt->toIso8601String(),
            'finished_at' => now()->toIso8601String(),
            'verification' => $verification,
        ];
    }

    /**
     * Run the statements of a dump through the application's own connection.
     *
     * @param  list<string>  $statements
     */
    private function execute(array $statements): void
    {
        $timeout = max(30, (int) config('backup.restore_timeout', 300));

        @set_time_limit($timeout);

        $pdo = DB::connection()->getPdo();

        $pdo->exec('SET SESSION max_execution_time = '.($timeout * 1000));
        $pdo->exec('SET FOREIGN_KEY_CHECKS=0');

        try {
            foreach ($statements as $index => $statement) {
                try {
                    $pdo->exec($statement);
                } catch (Throwable $exception) {
                    Log::error('Database restore statement failed.', [
                        'statement' => $index + 1,
                        'preview' => $this->redactStatement($statement),
                        'exception' => $exception,
                    ]);

                    throw $exception;
                }
            }
        } finally {
            $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
        }
    }

    /**
     * Put the database back to the state the safety backup holds.
     *
     * @return array{ok: bool}
     */
    private function recover(string $safetyPath): array
    {
        try {
            $dump = $this->validateDump($safetyPath);
            $this->execute($dump['statements']);

            return ['ok' => true];
        } catch (Throwable $exception) {
            Log::error('Database restore recovery failed.', ['exception' => $exception]);

            return ['ok' => false];
        }
    }

    /**
     * Compare the restored database with the dump.
     *
     * @param  array{tables: list<string>, statements: list<string>, rows: array<string, int>, size: int}  $dump
     * @return array{ok: bool, tables: int, checked: list<string>, mismatches: list<string>}
     */
    private function verify(array $dump): array
    {
        $checked = [];
        $mismatches = [];

        foreach ($dump['rows'] as $table => $expected) {
            if (! $this->tableExists($table)) {
                $mismatches[] = $table;

                continue;
            }

            $actual = (int) (DB::selectOne('select count(*) as aggregate from '.$this->quoteIdentifier($table))?->aggregate ?? -1);
            $checked[] = $table;

            if ($actual !== $expected) {
                $mismatches[] = $table;
            }
        }

        foreach ($dump['tables'] as $table) {
            if (! $this->tableExists($table)) {
                $mismatches[] = $table;
            }
        }

        $mismatches = array_values(array_unique($mismatches));

        return [
            'ok' => $mismatches === [],
            'tables' => count($dump['tables']),
            'checked' => $checked,
            'mismatches' => $mismatches,
        ];
    }

    private function tableExists(string $table): bool
    {
        $row = DB::selectOne(
            'select count(*) as aggregate from information_schema.tables
             where table_schema = database() and table_name = ?',
            [$table]
        );

        return (int) ($row?->aggregate ?? 0) > 0;
    }

    /**
     * Split a dump into single statements.
     *
     * Quoted text and comments are respected, so a semicolon inside a value
     * never ends a statement.
     *
     * @return list<string>
     */
    private function splitStatements(string $sql): array
    {
        $statements = [];
        $current = '';
        $length = strlen($sql);
        $inSingle = false;
        $inDouble = false;
        $inBacktick = false;
        $inLineComment = false;
        $inBlockComment = false;

        for ($i = 0; $i < $length; $i++) {
            $char = $sql[$i];
            $next = $i + 1 < $length ? $sql[$i + 1] : '';

            if ($inLineComment) {
                if ($char === "\n") {
                    $inLineComment = false;
                    $current .= $char;
                }

                continue;
            }

            if ($inBlockComment) {
                if ($char === '*' && $next === '/') {
                    $inBlockComment = false;
                    $i++;
                }

                continue;
            }

            if (! $inSingle && ! $inDouble && ! $inBacktick) {
                if ($char === '-' && $next === '-' && $this->startsComment($sql, $i)) {
                    $inLineComment = true;
                    $i++;

                    continue;
                }

                if ($char === '#') {
                    $inLineComment = true;

                    continue;
                }

                if ($char === '/' && $next === '*') {
                    $inBlockComment = true;
                    $i++;

                    continue;
                }
            }

            if ($inSingle && $char === '\\' && $next !== '') {
                $current .= $char.$next;
                $i++;

                continue;
            }

            if ($char === "'" && ! $inDouble && ! $inBacktick) {
                if ($inSingle && $next === "'") {
                    $current .= $char.$next;
                    $i++;

                    continue;
                }

                $inSingle = ! $inSingle;
                $current .= $char;

                continue;
            }

            if ($char === '"' && ! $inSingle && ! $inBacktick) {
                if ($inDouble && $next === '"') {
                    $current .= $char.$next;
                    $i++;

                    continue;
                }

                $inDouble = ! $inDouble;
                $current .= $char;

                continue;
            }

            if ($char === '`' && ! $inSingle && ! $inDouble) {
                $inBacktick = ! $inBacktick;
                $current .= $char;

                continue;
            }

            if ($char === ';' && ! $inSingle && ! $inDouble && ! $inBacktick) {
                $trimmed = trim($current);

                if ($trimmed !== '') {
                    $statements[] = $trimmed;
                }

                $current = '';

                continue;
            }

            $current .= $char;
        }

        $trimmed = trim($current);

        if ($trimmed !== '') {
            $statements[] = $trimmed;
        }

        return $statements;
    }

    /**
     * The number of rows each table should hold after the restore.
     *
     * @param  list<string>  $statements
     * @return array<string, int>
     */
    private function expectedRowCounts(array $statements): array
    {
        $counts = [];

        foreach ($statements as $statement) {
            if (preg_match('/^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?/i', $statement, $matches) !== 1) {
                continue;
            }

            $table = $matches[1];
            $counts[$table] = ($counts[$table] ?? 0) + $this->countTuples($statement);
        }

        return $counts;
    }

    /**
     * Count the value tuples of an INSERT statement.
     */
    private function countTuples(string $statement): int
    {
        $valuesAt = stripos($statement, 'VALUES');

        if ($valuesAt === false) {
            return 0;
        }

        $length = strlen($statement);
        $tuples = 0;
        $depth = 0;
        $inSingle = false;
        $inDouble = false;
        $inBacktick = false;

        for ($i = $valuesAt; $i < $length; $i++) {
            $char = $statement[$i];
            $next = $i + 1 < $length ? $statement[$i + 1] : '';

            if ($inSingle && $char === '\\' && $next !== '') {
                $i++;

                continue;
            }

            if ($char === "'" && ! $inDouble && ! $inBacktick) {
                if ($inSingle && $next === "'") {
                    $i++;

                    continue;
                }

                $inSingle = ! $inSingle;

                continue;
            }

            if ($char === '"' && ! $inSingle && ! $inBacktick) {
                $inDouble = ! $inDouble;

                continue;
            }

            if ($char === '`' && ! $inSingle && ! $inDouble) {
                $inBacktick = ! $inBacktick;

                continue;
            }

            if ($inSingle || $inDouble || $inBacktick) {
                continue;
            }

            if ($char === '(') {
                if ($depth === 0) {
                    $tuples++;
                }

                $depth++;

                continue;
            }

            if ($char === ')' && $depth > 0) {
                $depth--;
            }
        }

        return $tuples;
    }

    /**
     * A short, literal-free preview of a statement for the server log.
     */
    private function redactStatement(string $statement): string
    {
        $preview = preg_replace("/'[^']*'/", "'?'", $statement) ?? $statement;
        $preview = preg_replace('/\s+/', ' ', $preview) ?? $preview;

        return Str::limit($preview, 200, '');
    }

    private function startsComment(string $sql, int $position): bool
    {
        $after = $sql[$position + 2] ?? "\n";

        return $after === ' ' || $after === "\t" || $after === "\n" || $after === "\r";
    }

    private function quoteIdentifier(string $identifier): string
    {
        return '`'.str_replace('`', '``', $identifier).'`';
    }

    private function tokenKey(int $userId): string
    {
        return 'app:restore-token:'.$userId;
    }

    private function targetDatabase(): string
    {
        $connection = (string) config('database.default');

        return (string) config('database.connections.'.$connection.'.database');
    }
}
