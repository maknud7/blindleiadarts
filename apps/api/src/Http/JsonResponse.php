<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Http;

use Blindleia\Dartkiosk\Api\Support\RuntimeFailureDiagnostics;

final class JsonResponse
{
    private int $statusCode;

    /**
     * @var array<string, mixed>
     */
    private array $payload;

    /**
     * @param array<string, mixed> $payload
     */
    private function __construct(int $statusCode, array $payload)
    {
        $this->statusCode = $statusCode;
        $this->payload = $payload;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function ok(array $data, int $statusCode = 200): self
    {
        return new self($statusCode, [
            'ok' => true,
            'data' => $data,
        ]);
    }

    /**
     * @param array<string, mixed> $meta
     */
    public static function error(int $statusCode, string $code, string $message, array $meta = []): self
    {
        if ($statusCode >= 500) {
            $requestId = RuntimeFailureDiagnostics::requestId();
            $meta['request_id'] ??= $requestId;

            $path = (string) (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '');
            $log = json_encode([
                'event' => 'api_error_response',
                'request_id' => $requestId,
                'status' => $statusCode,
                'code' => $code,
                'method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'),
                'path' => $path,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
            error_log('runtime_failure ' . ($log !== false
                ? $log
                : '{"event":"api_error_response","encoding_error":true}'));
        }

        $error = [
            'code' => $code,
            'message' => $message,
        ];

        if ($meta !== []) {
            $error['meta'] = array_filter(
                $meta,
                static fn (mixed $value): bool => $value !== null
            );
        }

        return new self($statusCode, [
            'ok' => false,
            'error' => $error,
        ]);
    }

    public function send(): void
    {
        http_response_code($this->statusCode);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(
            $this->payload,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT
        );
    }
}
