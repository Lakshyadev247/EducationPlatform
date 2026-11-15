<?php

namespace App\Console\Commands;

use App\Models\Setting;
use Database\Seeders\ReferenceDataSeeder;
use Database\Seeders\RoleSeeder;
use Database\Seeders\SettingsSeeder;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PDO;
use Throwable;

#[Signature('app:install {--skip-migrations : Do not run database migrations} {--skip-link : Do not create the public storage link}')]
#[Description('Prepare this checkout to run: create/migrate the database, seed safe reference data and link public storage.')]
class InstallApplication extends Command
{
    public function handle(): int
    {
        if (! $this->prepareDatabase()) {
            return self::FAILURE;
        }

        if (! $this->option('skip-migrations')) {
            $this->info('Updating the database schema...');

            if ($this->call('migrate', ['--force' => true]) !== self::SUCCESS) {
                return self::FAILURE;
            }
        }

        /*
         * Roles and reference data are safe to refresh. Their seeders use
         * updateOrCreate and contain no accounts, bookings or personal data.
         *
         * The seeders are run directly rather than through "db:seed": that
         * command is refused by DatabaseGuard on a database that is not marked
         * disposable, because it can run demo data. This command only runs the
         * three safe seeders below.
         */
        try {
            app(RoleSeeder::class)->run();
            app(ReferenceDataSeeder::class)->run();

            /*
             * Settings hold administrator choices (backup destination,
             * schedule, notice text). They are only seeded when the table is
             * empty, so starting the application never overwrites a
             * configured install.
             */
            if (Schema::hasTable('settings') && Setting::query()->doesntExist()) {
                app(SettingsSeeder::class)->run();
            }
        } catch (Throwable $exception) {
            $this->error('The reference data could not be seeded.');
            $this->line($this->firstLine($exception->getMessage()));

            return self::FAILURE;
        }

        if (! $this->option('skip-link') && ! file_exists(public_path('storage'))) {
            try {
                $this->callSilent('storage:link');
                $this->info('Linked backend/public/storage.');
            } catch (Throwable $exception) {
                $this->warn('The public storage link could not be created: '.$exception->getMessage());
                $this->line('Uploaded photos will still save, but may not display until the link exists.');
            }
        }

        if (Schema::hasTable('users') && DB::table('users')->count() === 0) {
            $this->newLine();
            $this->line('No accounts exist yet. Create the first Super Admin with:');
            $this->line('  php artisan app:create-super-admin');
            $this->line('On Windows you can also double-click Create-Super-Admin.bat.');
        }

        $this->info('Application is ready.');

        return self::SUCCESS;
    }

    /**
     * Fail early with an actionable message, and create the MySQL schema when
     * the configured user is allowed to do so. A missing database is normal on
     * a fresh checkout; a rejected password or a stopped server is not.
     */
    private function prepareDatabase(): bool
    {
        $connectionName = (string) config('database.default');
        $config = (array) config('database.connections.'.$connectionName);

        if (($config['driver'] ?? null) !== 'mysql') {
            return true;
        }

        try {
            DB::connection($connectionName)->getPdo();

            return true;
        } catch (QueryException $exception) {
            $message = strtolower($exception->getMessage());

            if (! str_contains($message, 'unknown database')) {
                $this->error('The database connection failed.');
                $this->line($this->firstLine($exception->getMessage()));
                $this->line('Check DB_HOST, DB_PORT, DB_USERNAME and DB_PASSWORD in backend/.env.');

                return false;
            }
        }

        $database = (string) ($config['database'] ?? '');

        if (! preg_match('/^[A-Za-z0-9_]+$/', $database)) {
            $this->error('The database name in backend/.env contains unsupported characters.');

            return false;
        }

        try {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;charset=utf8mb4',
                $config['host'] ?? '127.0.0.1',
                $config['port'] ?? 3306,
            );

            $pdo = new PDO(
                $dsn,
                (string) ($config['username'] ?? ''),
                (string) ($config['password'] ?? ''),
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5],
            );

            $pdo->exec(sprintf(
                'CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
                $database,
            ));

            $this->info('Created the database "'.$database.'".');
        } catch (Throwable $exception) {
            $this->error('The database "'.$database.'" does not exist and could not be created.');
            $this->line($this->firstLine($exception->getMessage()));
            $this->line('Create it in MySQL and grant the configured user access, then run this command again.');

            return false;
        }

        DB::purge($connectionName);

        return true;
    }

    private function firstLine(string $message): string
    {
        $line = strtok($message, "\r\n");

        return $line === false ? $message : $line;
    }
}
