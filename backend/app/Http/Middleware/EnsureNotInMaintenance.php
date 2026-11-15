<?php

namespace App\Http\Middleware;

use App\Models\Role;
use App\Services\SettingsService;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Enforces general.maintenanceMode.
 *
 * The setting already existed and was stored, but nothing read it — an
 * administrator could switch it on and the platform carried on serving normally.
 *
 * Two things must keep working while maintenance is on, or the mode becomes a
 * lock-out with no way back:
 *
 *   1. administrators continue to use the whole API, including the admin panel
 *      that switches maintenance off again;
 *   2. the sign-in, session, health and meta routes stay reachable, because an
 *      administrator who is not yet signed in has to be able to sign in.
 *
 * Everyone else receives 503 with the configured notice.
 */
class EnsureNotInMaintenance
{
    public function __construct(private readonly SettingsService $settings) {}

    public function handle(Request $request, Closure $next): Response
    {
        if (! (bool) $this->settings->get('general.maintenanceMode', false)) {
            return $next($request);
        }

        // Always reachable: the escape hatch itself.
        if ($request->is(
            'api/v1/auth/*',
            'api/v1/health',
            'api/v1/meta',
            'api/v1/me',
        )) {
            return $next($request);
        }

        $user = $request->user();
        if ($user !== null && ($user->hasRole(Role::ADMIN) || $user->hasRole(Role::SUPER_ADMIN))) {
            return $next($request);
        }

        return response()->json([
            'message' => (string) $this->settings->get(
                'general.maintenanceNotice',
                'The platform is temporarily unavailable for maintenance. Please check back shortly.',
            ),
            'maintenance' => true,
        ], 503);
    }
}
