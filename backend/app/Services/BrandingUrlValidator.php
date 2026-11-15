<?php

namespace App\Services;

/**
 * The branding group holds image references that are sent to every visitor by
 * /api/v1/meta and rendered by the frontend. Only references to the
 * application's own upload directory are accepted, so a stored value can never
 * become markup in a browser.
 *
 * The rule lives in its own class so it can be checked without a database
 * connection and reused by the admin panel and the API.
 */
class BrandingUrlValidator
{
    /**
     * The branding slots that hold an image reference.
     *
     * @var list<string>
     */
    public const SLOTS = ['logo', 'logo2', 'favicon'];

    /**
     * Is this value an acceptable image reference?
     *
     * Accepted: null or an empty string (the slot is simply cleared), and a
     * URL whose path lies under the application's own public upload
     * directory, either root-relative ("/storage/...") or absolute
     * ("https://host/storage/...").
     *
     * Refused: everything else, including markup, javascript: and data: URLs,
     * paths that try to escape the upload directory, and external hosts.
     */
    public function isAllowed(mixed $value): bool
    {
        if ($value === null || $value === '') {
            return true;
        }

        if (! is_string($value)) {
            return false;
        }

        $path = $value;

        if (preg_match('#^https?://#i', $value) === 1) {
            $parts = parse_url($value);

            if (! is_array($parts) || ! isset($parts['host'])) {
                return false;
            }

            $path = $parts['path'] ?? '';
        }

        if (str_contains($path, '..') || str_contains($path, '//')) {
            return false;
        }

        return preg_match('#^/storage/[A-Za-z0-9._\-/]+$#', $path) === 1;
    }

    /**
     * Which slots of a branding payload hold a refused value?
     *
     * @param  array<string, mixed>  $branding
     * @return list<string>
     */
    public function refusedSlots(array $branding): array
    {
        $refused = [];

        foreach (self::SLOTS as $slot) {
            if (! array_key_exists($slot, $branding)) {
                continue;
            }

            if (! $this->isAllowed($branding[$slot])) {
                $refused[] = $slot;
            }
        }

        return $refused;
    }
}
