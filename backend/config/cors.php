<?php

/**
 * Cross-origin resource sharing.
 *
 * The application and the frontend are served from the same origin, so no
 * origin is allowed by default. A deployment that splits them has to list its
 * frontend origins in CORS_ALLOWED_ORIGINS (and in SANCTUM_STATEFUL_DOMAINS).
 * A credentialed wildcard is never used.
 */
return [
    'paths' => ['api/*', 'sanctum/csrf-cookie'],

    'allowed_methods' => ['*'],

    'allowed_origins' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('CORS_ALLOWED_ORIGINS', ''))
    ))),

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [],

    'max_age' => 0,

    'supports_credentials' => true,
];
