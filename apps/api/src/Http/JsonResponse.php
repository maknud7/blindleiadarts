<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Http;

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\RuntimeFailureDiagnostics;
use Throwable;

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

            $environment = 'unknown';
            try {
                $environment = Config::load(dirname(__DIR__, 2))->appEnv();
            } catch (Throwable) {
                // Keep response handling available even if configuration loading failed.
            }
            $exposeDiagnostics = $environment === 'test';

            // Fail closed: exception/SQL details are allowed only in TEST. This
            // also protects responses if the runtime environment cannot be resolved.
            if (!$exposeDiagnostics) {
                foreach (['details', 'detail', 'exception', 'exception_message', 'exception_code'] as $key) {
                    unset($meta[$key]);
                }
            }

            $logPayload = [
                'event' => 'api_error_response',
                'environment' => $environment,
                'request_id' => $requestId,
                'status' => $statusCode,
                'code' => $code,
                'method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'),
                'path' => (string) (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: ''),
            ];
            if ($exposeDiagnostics) {
                foreach (['details', 'detail', 'exception'] as $key) {
                    $value = $meta[$key] ?? null;
                    if (is_scalar($value) && $value !== '') {
                        $logPayload[$key] = $value;
                    }
                }
            }

            $json = json_encode(
                $logPayload,
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR
            );
            error_log('runtime_failure ' . ($json !== false
                ? $json
                : '{"event":"api_error_response","encoding_error":true}'));
            RuntimeFailureDiagnostics::markResponseLogged();
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
