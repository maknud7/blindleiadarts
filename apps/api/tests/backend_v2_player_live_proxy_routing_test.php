<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2PlayerLiveProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2PlayerLiveProxyApplication(dirname(__DIR__));

foreach ([
    ['GET', '/v1/realtime/config'],
    ['GET', '/v1/me/dashboard'],
    ['GET', '/v1/clubs'],
    ['GET', '/v1/clubs/1/player-directory'],
    ['GET', '/v1/clubs/1/elo'],
    ['GET', '/v1/clubs/1/summaries'],
    ['GET', '/v1/players/17/profile'],
    ['GET', '/v1/players/17/matches'],
    ['GET', '/v1/players/17/elo-tournaments'],
    ['GET', '/v1/matches/101/detail'],
    ['GET', '/v1/tournaments/429/tables'],
    ['GET', '/v1/tournaments/429/results'],
    ['GET', '/v1/tournaments/429/summary'],
    ['GET', '/v1/tournaments/429/live-highlights'],
    ['GET', '/v1/clubs/1/seasons'],
    ['GET', '/v1/seasons/1'],
    ['GET', '/v1/seasons/1/standings'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 player/live reads.");
}

// This front door is deliberately read-only. Club/player/season/tournament mutations
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
    ['PUT', '/v1/tournaments/429/summary/admin'],
    ['PATCH', '/v1/tournaments/429/summary/admin'],
    ['POST', '/v1/tournaments/429/matches'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must remain outside the read-only backend-v2 proxy.");
}

$assert(!$proxy->handles('GET', '/v1/seasons/1/activate'), 'Unsupported season read path must not be captured.');
$assert(!$proxy->handles('GET', '/v1/clubs/1/tournaments'), 'Unmigrated public reads must not be captured accidentally.');
$assert(!$proxy->handles('GET', '/v1/tournaments/429/summary/admin'), 'Admin summary read must remain outside this public read slice.');

// These look like reads, but their current PHP implementations can mutate state:
// public Live may capture/self-heal tournament ELO baselines, and check-in display
// may rotate/persist a missing check-in code. They need dedicated single-writer
// cutovers rather than being swept into this GET-only proxy.
$assert(!$proxy->handles('GET', '/v1/public/clubs/blindleia-dartklubb/live'), 'Public Live must remain outside the pure-read proxy until ELO side effects are explicit.');
$assert(!$proxy->handles('GET', '/v1/public/tournaments/429/live'), 'Tournament Live must remain outside the pure-read proxy until ELO side effects are explicit.');
$assert(!$proxy->handles('GET', '/v1/public/check-in-display'), 'Check-in display must remain outside the pure-read proxy while it may rotate a code.');

echo "BackendV2PlayerLiveProxy routing OK\n";
