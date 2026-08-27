<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use RuntimeException;

final class ValidationException extends RuntimeException
{
    private string $errorCode;
    private int $statusCode;

    public function __construct(string $errorCode, ?string $message = null, int $statusCode = 422)
    {
        if ($message === null) {
            $message = $errorCode;
            $errorCode = 'validation_error';
        }
        $this->errorCode = $errorCode;
        $this->statusCode = $statusCode;
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
