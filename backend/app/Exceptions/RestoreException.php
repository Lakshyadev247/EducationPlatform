<?php

namespace App\Exceptions;

use RuntimeException;
use Throwable;

/**
 * A restore that was refused or that failed.
 *
 * The message is written for the Super Admin and never contains SQL, a
 * password, a token or a row of personal data. The technical detail stays in
 * the server log.
 */
class RestoreException extends RuntimeException
{
    /**
     * @param  array<string, mixed>  $context
     */
    public function __construct(
        string $message,
        private readonly string $reason = 'failed',
        private readonly array $context = [],
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function reason(): string
    {
        return $this->reason;
    }

    /**
     * @return array<string, mixed>
     */
    public function context(): array
    {
        return $this->context;
    }
}
