<?php

declare(strict_types=1);

/** @var array{config:array<string,mixed>,db:mysqli,prefix:string,adapter:DartsAtlasLiveAdapter} $app */
$app = require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');

try {
    $payload = $app['adapter']->liveState();
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    );
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode([
        'error' => 'live_state_failed',
        'message' => $error->getMessage(),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
