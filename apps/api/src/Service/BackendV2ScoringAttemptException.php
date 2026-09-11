<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use RuntimeException;
use Throwable;

/**
 * A backend-v2 mutation request was sent or may have been sent.
 *
 * The caller must never perform the same scoring mutation through PHP after
 * this exception. A timeout or response failure can happen after MySQL commit,
 * so retrying through another writer would risk a duplicate canonical write.
 */
final class BackendV2ScoringAttemptException extends RuntimeException
{
    public function __construct(
        string $message,
        private readonly ?int $httpStatus = null,
        private readonly ?string $backendErrorCode = null,
        ?Throwable $previous = null
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function httpStatus(): ?int
    {
        return $this->httpStatus;
    }

    public function backendErrorCode(): ?string
    {
        return $this->backendErrorCode;
    }

    public function allowsPhpFallback(): bool
    {
        return false;
    }
}
