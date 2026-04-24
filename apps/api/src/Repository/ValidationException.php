<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use RuntimeException;

final class ValidationException extends RuntimeException
{
    public function __construct(
        private string $errorCode,
        string $message,
        private int $statusCode = 422
    ) {
        parent::__construct($message);
    }

    public function errorCode(): string
    {
        return $this->errorCode;
    }

    public function statusCode(): int
    {
        return $this->statusCode;
    }
}
