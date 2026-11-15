<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureUserHasRole
{
    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next, string ...$roles): Response
    {
        $user = $request->user();

        if ($user === null || $user->status !== 'active' || ! $user->hasAnyRole($roles)) {
            abort(403, 'You do not have permission to perform this action.');
        }

        return $next($request);
    }
}
