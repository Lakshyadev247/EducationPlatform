<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * Raised when a backup or restore is already running.
 *
 * The operation is not wrong, it is only not possible right now, so the API
 * answers with 409 Conflict instead of a server error.
 */
class BackupInProgressException extends RuntimeException
{
    public function __construct(string $message = 'Another backup or restore operation is already running.')
    {
        parent::__construct($message);
    }
}
