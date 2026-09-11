<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2PlayerLiveProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2PlayerLiveProxyApplication(dirname(__DIR__));

foreach ([
    ['GET', '/v1/me/dashboard'],
    ['GET', '/v1/clubs'],
    ['GET', '/v1/clubs/1/player-directory'],
    ['GET', '/v1/clubs/1/elo'],
    ['GET', '/v1/players/17/profile'],
    ['GET', '/v1/players/17/matches'],
    ['GET', '/v1/players/17/elo-tournaments'],
    ['GET', '/v1/tournaments/429/live-highlights'],
    ['GET', '/v1/clubs/1/seasons'],
    ['GET', '/v1/seasons/1'],
    ['GET', '/v1/seasons/1/standings'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 player/live reads.");
}

// This front door is deliberately read-only. Club/player/season mutations must
// remain with their existing writers until a dedicated single-writer cutover.
foreach ([
    ['POST', '/v1/clubs'],
    ['POST', '/v1/clubs/1/players'],
    ['PATCH', '/v1/players/17/profile'],
    ['POST', '/v1/clubs/1/seasons'],
    ['PATCH', '/v1/seasons/1'],
    ['PUT', '/v1/seasons/1'],
    ['POST', '/v1/seasons/1/activate'],
    ['POST', '/v1/seasons/1/complete'],
    ['DELETE', '/v1/seasons/1'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must remain outside the read-only backend-v2 proxy.");
}

$assert(!$proxy->handles('GET', '/v1/seasons/1/activate'), 'Unsupported season read path must not be captured.');
$assert(!$proxy->handles('GET', '/v1/clubs/1/tournaments'), 'Unmigrated public reads must not be captured accidentally.');
$assert(!$proxy->handles('GET', '/v1/matches/1/detail'), 'Match detail remains outside this read slice.');

echo "BackendV2PlayerLiveProxy routing OK\n";
