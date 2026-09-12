<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2ScoliaProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2ScoliaProxyApplication(dirname(__DIR__));

foreach ([
    ['GET', '/v1/scolia/bridge/config'],
    ['POST', '/v1/scolia/bridge/events'],
    ['POST', '/v1/scolia/bridge/drain'],
    ['POST', '/v1/scolia/bridge/heartbeat'],
    ['POST', '/v1/scolia/bridge/commands/poll'],
    ['GET', '/v1/scolia/bridge/commands/17'],
    ['POST', '/v1/scolia/bridge/commands/17/result'],
    ['GET', '/v1/kiosks/BOARD-1/scolia'],
    ['GET', '/v1/kiosks/BOARD-1/scolia/status'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/fallback'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/resume'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/reset-phase'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/delete-throw'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/correct-throw'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/test-lease/acquire'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/test-lease/heartbeat'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/test-lease/release'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 Scolia runtime.");
}

foreach ([
    ['PATCH', '/v1/scolia/bridge/config'],
    ['GET', '/v1/scolia/bridge/events'],
    ['POST', '/v1/scolia/bridge/commands/not-an-id/result'],
    ['PATCH', '/v1/kiosks/BOARD-1/scolia'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/unknown'],
    ['GET', '/v1/kiosks/BOARD-1/scolia/test-lease/acquire'],
    ['POST', '/v1/kiosks/BOARD-1/scolia/test-lease/unknown'],
    ['GET', '/v1/clubs/1/kiosks/9/scolia'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must not be captured by Scolia runtime proxy.");
}

echo "BackendV2ScoliaProxy routing OK\n";
