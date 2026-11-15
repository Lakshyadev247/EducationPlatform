<?php

namespace App\Console\Commands;

use App\Services\DatabaseBackupService;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('app:backup-database {--force : Create a backup even when the schedule is off or already satisfied}')]
#[Description('Create a scheduled or forced SQL backup of the configured database.')]
class BackupDatabase extends Command
{
    public function handle(DatabaseBackupService $backups): int
    {
        if (! $this->option('force') && ! $backups->isScheduleDue()) {
            $this->info('No backup is due.');

            return self::SUCCESS;
        }

        $backup = $backups->create();

        $this->info(sprintf(
            'Backup created: %s (%s bytes).',
            $backup['name'],
            number_format($backup['size'])
        ));

        return self::SUCCESS;
    }
}
