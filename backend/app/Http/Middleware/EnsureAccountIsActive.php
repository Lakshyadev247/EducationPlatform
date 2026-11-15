<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Blocks a request from an account that is no longer active.
 *
 * A suspended account could not sign in again, but a session that was issued
 * before the suspension stayed valid. The status was only checked on the
 * routes that carry the role middleware, so the other authenticated routes
 * (the profile, the bookings, the attendance, the notifications) still served a
 * suspended user until the session expired.
 *
 * This middleware closes that gap. It runs on every authenticated API route
 * and refuses the request when the account is suspended, closed or deleted.
 * The session is ended as well, so the client is not left holding a session
 * that can never work again.
 *
 * Anonymous requests are not affected: a public page must stay public, and a
 * request without a user has no account to check.
 */
class EnsureAccountIsActive
{
    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user === null) {
            return $next($request);
        }

        if ($user->status === 'active' && ! $user->trashed()) {
            return $next($request);
        }

        // The account can no longer be used, so the session that is presenting
        // it is ended instead of being left to expire on its own.
        if ($request->hasSession()) {
            auth()->guard('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }

        abort(403, 'This account is not active.');
    }
}
