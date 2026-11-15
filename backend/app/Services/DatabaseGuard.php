<?php

namespace App\Services;

use Illuminate\Contracts\Foundation\Application;
use RuntimeException;

/**
 * Guards the environment/database pairing and the commands that can destroy
 * data.
 *
 * Two independent protections:
 *
 *  1. Runtime. The environment and the connected database must agree. A
 *     "browser" or "testing" instance may only run on a database whose name
 *     ends in "_test", and a production instance may never run on one. This
 *     is what stops a missing, renamed or edited environment file from
 *     silently moving the application onto a different database: the mismatch
 *     is reported instead of being ignored.
 *
 *  2. Console. Commands that can empty a database (migrate:fresh,
 *     migrate:reset, migrate:refresh, db:wipe, db:seed) are refused unless the
 *     connected database has been explicitly marked disposable. A database
 *     that holds demo or real records is therefore protected even when
 *     somebody runs the wrong command.
 *
 * The rules are deliberately based on configuration only, so they can be
 * checked without a database connection.
 */
class DatabaseGuard
{
    /**
     * Commands that can empty or overwrite the contents of a database.
     *
     * @var list<string>
     */
    private const DESTRUCTIVE_COMMANDS = [
        'migrate:fresh',
        'migrate:reset',
        'migrate:refresh',
        'db:wipe',
        'db:seed',
        'db:reset',
    ];

    public function __construct(private readonly Application $app) {}

    public function connectedDatabase(): string
    {
        $connection = (string) config('database.default');

        return (string) config('database.connections.'.$connection.'.database');
    }

    /**
     * A database is disposable only when it has been listed explicitly.
     *
     * Nothing is disposable by default, so an operator has to say which
     * database may be emptied before any command that empties one runs.
     */
    public function isDisposable(?string $database = null): bool
    {
        $database = $database ?? $this->connectedDatabase();

        if ($database === '') {
            return false;
        }

        return in_array($database, $this->disposableDatabases(), true);
    }

    /**
     * @return list<string>
     */
    public function disposableDatabases(): array
    {
        $configured = (string) env('DISPOSABLE_DATABASES', '');

        return array_values(array_filter(array_map('trim', explode(',', $configured))));
    }

    public function isDestructiveCommand(string $command): bool
    {
        return in_array($command, self::DESTRUCTIVE_COMMANDS, true);
    }

    /**
     * Refuse a command that can empty the connected database unless that
     * database was explicitly marked disposable.
     */
    public function assertCommandIsAllowed(string $command): void
    {
        if (! $this->isDestructiveCommand($command)) {
            return;
        }

        if ((bool) env('ALLOW_DESTRUCTIVE_DB_COMMANDS', false)) {
            return;
        }

        if ($this->isDisposable()) {
            return;
        }

        throw new RuntimeException(sprintf(
            'Refusing to run "%s": the connected database "%s" is not marked disposable. '
            .'Add it to DISPOSABLE_DATABASES in the environment file, or set '
            .'ALLOW_DESTRUCTIVE_DB_COMMANDS=true if you really mean it.',
            $command,
            $this->connectedDatabase()
        ));
    }

    /**
     * The environment and the connected database must agree.
     */
    public function assertEnvironmentMatchesDatabase(): void
    {
        $environment = $this->app->environment();
        $database = $this->connectedDatabase();

        if ($database === '') {
            return;
        }

        $looksDisposable = str_ends_with($database, '_test');

        if (in_array($environment, ['browser', 'testing'], true) && ! $looksDisposable) {
            throw new RuntimeException(sprintf(
                'The "%s" environment must not run on the database "%s". A browser or test instance '
                .'may only use a database whose name ends in "_test", so a missing or edited environment '
                .'file cannot move the application onto another database. Restore the environment file '
                .'for this environment, or start the server with a different APP_ENV.',
                $environment,
                $database
            ));
        }

        if ($environment === 'production' && $looksDisposable) {
            throw new RuntimeException(sprintf(
                'The production environment must not run on the disposable database "%s".',
                $database
            ));
        }
    }
}
