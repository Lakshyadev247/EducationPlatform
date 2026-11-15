<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Adds the response headers a browser needs to enforce the platform's defences.
 *
 * The policy is deliberately conservative and configurable:
 *  - the frontend is served as a static page with one external script and four
 *    inline style attributes, so scripts may only come from this origin while
 *    inline styles are allowed;
 *  - Google Fonts is the only external resource the page uses;
 *  - HSTS is only sent when the deployment says it is served over HTTPS
 *    (SECURITY_HSTS_ENABLED); sending it over plain HTTP would be ignored and
 *    can strand a host that later moves to HTTPS.
 */
class SecurityHeaders
{
    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        if (! config('security.headers.enabled')) {
            return $response;
        }

        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('X-Frame-Options', 'SAMEORIGIN');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        $response->headers->set('Cross-Origin-Opener-Policy', 'same-origin');

        if (config('security.headers.csp')) {
            $response->headers->set('Content-Security-Policy', $this->contentSecurityPolicy());
        }

        if ($request->isSecure() && config('security.headers.hsts')) {
            $response->headers->set(
                'Strict-Transport-Security',
                'max-age='.(int) config('security.headers.hsts_max_age').'; includeSubDomains'
            );
        }

        return $response;
    }

    private function contentSecurityPolicy(): string
    {
        return implode('; ', [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'self'",
            "form-action 'self'",
            "script-src 'self'",
            // index.html uses four inline style attributes. Allowing inline
            // styles keeps them working without moving them into a build step.
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
        ]);
    }
}
