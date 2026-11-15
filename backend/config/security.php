<?php

/**
 * Security settings that an operator can tune per deployment.
 *
 * The defaults are safe: no proxy is trusted unless it is named, CORS is not
 * opened to any origin, and HSTS is only sent when an operator confirms that
 * the site is served over HTTPS.
 */
return [
    /**
     * The single password rule shared by public signup and by an
     * administrator creating an account. Existing passwords are never
     * re-validated on sign-in, so raising this value does not lock anyone out.
     */
    'password' => [
        'min_length' => (int) env('SECURITY_PASSWORD_MIN_LENGTH', 12),
        'max_length' => 100,
    ],

    'headers' => [
        'enabled' => filter_var(env('SECURITY_HEADERS_ENABLED', true), FILTER_VALIDATE_BOOL),
        'csp' => filter_var(env('SECURITY_CSP_ENABLED', true), FILTER_VALIDATE_BOOL),
        // HSTS is only meaningful on HTTPS. It stays off until the deployment
        // confirms that every request is served over HTTPS.
        'hsts' => filter_var(env('SECURITY_HSTS_ENABLED', false), FILTER_VALIDATE_BOOL),
        'hsts_max_age' => (int) env('SECURITY_HSTS_MAX_AGE', 31536000),
    ],

    /**
     * Requests per minute for the sensitive endpoints. Registration and login
     * keep their route level limit (5 per minute).
     */
    'rate_limits' => [
        'password_reset_request' => (int) env('SECURITY_RATE_PASSWORD_RESET', 3),
        'password_reset_submit' => (int) env('SECURITY_RATE_PASSWORD_RESET_SUBMIT', 5),
        'whatsapp_test' => (int) env('SECURITY_RATE_WHATSAPP_TEST', 10),
        'backup_create' => (int) env('SECURITY_RATE_BACKUP_CREATE', 6),
        'backup_download' => (int) env('SECURITY_RATE_BACKUP_DOWNLOAD', 6),
        'backup_restore' => (int) env('SECURITY_RATE_BACKUP_RESTORE', 2),
        'backup_restore_token' => (int) env('SECURITY_RATE_BACKUP_RESTORE_TOKEN', 5),
    ],
];
