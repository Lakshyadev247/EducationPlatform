<?php

namespace App\Providers;

use App\Models\User;
use App\Policies\UserPolicy;
use App\Services\DatabaseGuard;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Console\Events\CommandStarting;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Gate::policy(User::class, UserPolicy::class);

        // Sensitive endpoints get their own configurable limit. The limits are
        // deliberately narrow: a blanket API limit would throttle legitimate
        // bursts (an administrator working through a list, a student loading a
        // dashboard) without protecting anything that is not already
        // authenticated and role gated.
        RateLimiter::for('password-reset-request', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.password_reset_request', 3)
        )->by($request->ip()));

        RateLimiter::for('password-reset-submit', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.password_reset_submit', 5)
        )->by($request->ip()));

        RateLimiter::for('whatsapp-test', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.whatsapp_test', 10)
        )->by((string) ($request->user()?->getKey() ?? $request->ip())));

        // Creating a backup reads every table of the database, so the limit
        // is deliberately narrow and counted per account.
        RateLimiter::for('backup-create', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.backup_create', 6)
        )->by((string) ($request->user()?->getKey() ?? $request->ip())));

        RateLimiter::for('backup-download', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.backup_download', 6)
        )->by((string) ($request->user()?->getKey() ?? $request->ip())));

        // A restore replaces the database, so it is the most restricted
        // operation in the panel.
        RateLimiter::for('backup-restore', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.backup_restore', 2)
        )->by((string) ($request->user()?->getKey() ?? $request->ip())));

        RateLimiter::for('backup-restore-token', fn (Request $request) => Limit::perMinute(
            (int) config('security.rate_limits.backup_restore_token', 5)
        )->by((string) ($request->user()?->getKey() ?? $request->ip())));

        $guard = new DatabaseGuard($this->app);

        // The environment and the connected database must agree. This is what
        // makes an environment file safe: a missing or edited file can no
        // longer move the application onto another database silently, because
        // the mismatch is reported instead of ignored.
        $guard->assertEnvironmentMatchesDatabase();

        // A production instance with debug mode on returns full stack traces,
        // environment values and SQL to anybody who can reach an error page.
        // Failing here is loud and immediate instead of quiet and late.
        if ($this->app->isProduction() && (bool) config('app.debug')) {
            throw new RuntimeException(
                'APP_DEBUG must be false in production. Refusing to serve with debug mode enabled.'
            );
        }

        // Commands that can empty a database are refused unless that database
        // was explicitly marked disposable.
        Event::listen(CommandStarting::class, function (CommandStarting $event) use ($guard): void {
            $guard->assertCommandIsAllowed($event->command);
        });
    }
}
