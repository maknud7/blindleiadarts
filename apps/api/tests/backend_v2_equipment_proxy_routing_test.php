<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2EquipmentProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2EquipmentProxyApplication(dirname(__DIR__));

foreach ([
    ['GET', '/v1/clubs/1/kiosks'],
    ['POST', '/v1/clubs/1/kiosks'],
    ['PATCH', '/v1/clubs/1/kiosks/9'],
    ['DELETE', '/v1/clubs/1/kiosks/9'],
    ['POST', '/v1/clubs/1/kiosks/9/reset-pairing'],
    ['GET', '/v1/clubs/1/kiosk-pairing-requests'],
    ['POST', '/v1/clubs/1/kiosk-pairing-requests/ABC123/approve'],
    ['POST', '/v1/kiosk-pairing-requests'],
    ['GET', '/v1/kiosk-pairing-requests/ABC123'],
    ['GET', '/v1/clubs/1/screen-devices'],
    ['POST', '/v1/clubs/1/screen-devices'],
    ['DELETE', '/v1/clubs/1/screen-devices/7'],
    ['GET', '/v1/clubs/1/scolia'],
    ['PATCH', '/v1/clubs/1/scolia/settings'],
    ['GET', '/v1/clubs/1/kiosks/9/scolia'],
    ['POST', '/v1/clubs/1/kiosks/9/scolia/fallback'],
    ['POST', '/v1/clubs/1/kiosks/9/scolia/resume'],
    ['POST', '/v1/clubs/1/kiosks/9/scolia/reset-phase'],
    ['POST', '/v1/clubs/1/scolia/incidents/4/resolve'],
    ['POST', '/v1/clubs/1/scolia/events/5/retry'],
    ['POST', '/v1/clubs/1/scolia/cleanup'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 equipment.");
}

// Scolia bridge/runtime and queue drain are separate runtime surfaces, not this admin cutover.
$assert(!$proxy->handles('POST', '/v1/clubs/1/scolia/queue/drain'), 'Scolia queue drain is not part of this cutover.');
$assert(!$proxy->handles('POST', '/v1/scolia/bridge/events'), 'Scolia bridge must not be captured by equipment proxy.');
$assert(!$proxy->handles('POST', '/v1/kiosks/BOARD-1/scolia/fallback'), 'Kiosk Scolia runtime remains outside admin proxy.');

echo "BackendV2EquipmentProxy routing OK\n";
