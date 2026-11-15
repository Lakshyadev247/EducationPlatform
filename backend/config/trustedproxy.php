<?php

/**
 * Trusted reverse proxies.
 *
 * Forwarded headers (X-Forwarded-For, X-Forwarded-Proto, ...) decide the
 * client address and whether a request is treated as HTTPS, so only a proxy
 * the operator names may set them. An empty value trusts nothing, which is the
 * correct default for a directly served deployment.
 *
 * Set TRUSTED_PROXIES to a comma separated list of proxy addresses or CIDR
 * ranges (for example "10.0.0.2,10.0.0.0/24"). Never use "*".
 */
return [
    'proxies' => (function (): ?array {
        $configured = trim((string) env('TRUSTED_PROXIES', ''));

        if ($configured === '') {
            return null;
        }

        $proxies = array_values(array_filter(array_map('trim', explode(',', $configured))));

        return $proxies === [] ? null : $proxies;
    })(),
];
