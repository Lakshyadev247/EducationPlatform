<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// The command decides whether today's backup is due from the configured time
// and whether one already exists, so the scheduler only has to wake it hourly.
Schedule::command('app:backup-database')
    ->hourly()
    ->withoutOverlapping();
