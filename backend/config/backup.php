<?php

return [
    /*
     * The folder the application may write backups into.
     *
     * An empty value keeps the backup area inside backend/storage/app. A server
     * owner can point this at another disk, for example an external drive; the
     * backup area is then the "backups" folder below it and the Super Admin
     * picks a folder inside that area. The browser is never allowed to choose
     * a path outside it.
     */
    'base' => env('BACKUP_BASE', ''),

    /*
     * Additional folders the server owner authorises as backup destinations.
     *
     * Each entry is an absolute path on the machine that runs Laravel. The
     * Super Admin may browse and pick folders inside them; nothing outside
     * them is reachable, and the paths are never taken from the browser.
     */
    'roots' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('BACKUP_ROOTS', ''))
    ))),

    /*
     * The largest dump that may be uploaded for a restore.
     */
    'max_upload_bytes' => (int) env('BACKUP_MAX_UPLOAD_BYTES', 104857600),

    /*
     * How long a single restore may run, in seconds.
     */
    'restore_timeout' => (int) env('BACKUP_RESTORE_TIMEOUT', 300),
];
