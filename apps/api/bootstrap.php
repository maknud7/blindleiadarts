<?php

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $connectorBasePath = dirname(__DIR__, 1) . '/packages/connectors/src/';

    if (!is_dir($connectorBasePath)) {
        $connectorBasePath = dirname(__DIR__, 2) . '/packages/connectors/src/';
    }

    $prefixes = [
        'Blindleia\\Dartkiosk\\Api\\' => __DIR__ . '/src/',
        'Blindleia\\Dartkiosk\\Connectors\\' => $connectorBasePath,
    ];

    foreach ($prefixes as $prefix => $basePath) {
        if (!str_starts_with($class, $prefix)) {
            continue;
        }

        $relativeClass = substr($class, strlen($prefix));
        $path = $basePath . str_replace('\\', '/', $relativeClass) . '.php';

        if (is_file($path)) {
            require $path;
        }

        return;
    }
});

if (PHP_SAPI !== 'cli') {
    $runtimeRequestId = \Blindleia\Dartkiosk\Api\Support\RuntimeFailureDiagnostics::requestId();

    register_shutdown_function(static function () use ($runtimeRequestId): void {
        $status = http_response_code();
        if ($status < 500) {
            return;
        }

        $payload = [
            'event' => 'api_request_failed',
            'request_id' => $runtimeRequestId,
            'status' => $status,
            'method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'),
            'path' => (string) (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: ''),
        ];
        $json = json_encode(
            $payload,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR
        );
        error_log('runtime_failure ' . ($json !== false
            ? $json
            : '{"event":"api_request_failed","encoding_error":true}'));
    });
}
