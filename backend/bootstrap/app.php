<?php

use App\Http\Middleware\EnsureNotInMaintenance;
use App\Http\Middleware\EnsureUserHasRole;
use App\Http\Middleware\SecurityHeaders;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->statefulApi();

        // Security response headers apply to the API and to the static page.
        $middleware->append(SecurityHeaders::class);

        // Trusted reverse proxies come from config/trustedproxy.php
        // (TRUSTED_PROXIES). Nothing is trusted unless it is named there.

        // General setting enforcement: maintenance mode is checked on every API
        // request. See App\Http\Middleware\EnsureNotInMaintenance.
        $middleware->api(append: [
            EnsureNotInMaintenance::class,
        ]);

        $middleware->alias([
            'role' => EnsureUserHasRole::class,
        ]);

        $middleware->redirectGuestsTo(
            fn (Request $request) => $request->is('api/*') ? null : '/'
        );
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        $exceptions->render(function (AuthenticationException $exception, Request $request) {
            if ($request->is('api/*')) {
                return response()->json(['message' => 'Unauthenticated.'], 401);
            }
        });
    })->create();
