<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use RuntimeException;
use Throwable;

/**
 * Raised only after a backend-v2 HTTP attempt may have happened.
 *
 * Callers must never fall back to a PHP mutation after this exception because
 * the remote outcome may be unknown. This is the generic counterpart to the
 * scoring-specific single-writer attempt exception.
 */
final class BackendV2ApiAttemptException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly ?int $statusCode = null,
        public readonly string $errorCode = 'backend_v2_api_attempt_failed',
        ?Throwable $previous = null
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function allowsPhpFallback(): bool
    {
        return false;
    }
}
