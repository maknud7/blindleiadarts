<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use Throwable;

final class RuntimeFailureDiagnostics
{
    private static ?string $requestId = null;
    private static bool $responseLogged = false;

    public static function requestId(): string
    {
        if (self::$requestId !== null) {
            return self::$requestId;
        }

        $candidate = trim((string) ($_SERVER['HTTP_X_REQUEST_ID'] ?? ''));
        if ($candidate !== '' && preg_match('/^[A-Za-z0-9._:-]{1,64}$/', $candidate) === 1) {
            self::$requestId = $candidate;
        } else {
            try {
                self::$requestId = bin2hex(random_bytes(8));
            } catch (Throwable) {
                self::$requestId = substr(hash('sha256', uniqid('', true)), 0, 16);
            }
        }

        if (!headers_sent()) {
            header('X-Request-ID: ' . self::$requestId);
        }

        return self::$requestId;
    }

    public static function markResponseLogged(): void
    {
        self::$responseLogged = true;
    }

    public static function responseWasLogged(): bool
    {
        return self::$responseLogged;
    }

    /** @return array<string, mixed> */
    public static function details(?Config $config, Throwable $exception): array
    {
        $details = ['request_id' => self::requestId()];

        if ($config !== null && $config->appEnv() !== 'prod') {
            $details['exception'] = $exception::class;
            $details['exception_code'] = $exception->getCode();
            $details['exception_message'] = $exception->getMessage();
        }

        return $details;
    }

    /** @param array<string, scalar|null> $context */
    public static function log(?Config $config, string $surface, Throwable $exception, array $context = []): void
    {
        $environment = $config?->appEnv() ?? 'unknown';
        $payload = [
            'event' => 'api_runtime_failure',
            'environment' => $environment,
            'request_id' => self::requestId(),
            'surface' => $surface,
            'exception' => $exception::class,
            'exception_code' => $exception->getCode(),
        ];

        foreach ($context as $key => $value) {
            if (preg_match('/token|secret|password|authorization|cookie/i', $key) === 1) {
                continue;
            }
            $payload[$key] = $value;
        }

        // Exception text can contain SQL/schema details. Keep it out of PROD logs.
        if ($environment !== 'prod') {
            $payload['exception_message'] = $exception->getMessage();
        }

        $json = json_encode(
            $payload,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR
        );

        error_log('runtime_failure ' . ($json !== false
            ? $json
            : '{"event":"api_runtime_failure","encoding_error":true}'));
    }
}
