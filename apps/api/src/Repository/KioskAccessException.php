<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use RuntimeException;

final class KioskAccessException extends RuntimeException
{
    private string $errorCode;
    private int $statusCode;

    public function __construct(string $errorCode, string $message, int $statusCode)
    {
        parent::__construct($message);
        $this->errorCode = $errorCode;
        $this->statusCode = $statusCode;
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
