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
    ['GET', '/v1/public/clubs/blindleia-dartklubb/live'],
    ['GET', '/v1/public/tournaments/429/live'],
    ['GET', '/v1/public/check-in-display'],
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

// This front door is deliberately read-only. Club/player/season/tournament/check-in
// mutations remain with their explicit writers until a dedicated single-writer cutover.
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
    ['POST', '/v1/tournaments/429/check-in'],
    ['POST', '/v1/tournaments/429/checkin-code/rotate'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must remain outside the read-only backend-v2 proxy.");
}

$assert(!$proxy->handles('GET', '/v1/seasons/1/activate'), 'Unsupported season read path must not be captured.');
$assert(!$proxy->handles('GET', '/v1/clubs/1/tournaments'), 'Unmigrated public reads must not be captured accidentally.');
$assert(!$proxy->handles('GET', '/v1/tournaments/429/summary/admin'), 'Admin summary read must remain outside this public read slice.');

// Public live/check-in display are safe here only because their read implementations
// are now side-effect free. ELO baseline capture, check-in code generation and screen
// heartbeat are explicit mutation concerns and must not be reintroduced from GET.
$assert(!$proxy->handles('POST', '/v1/public/check-in-display'), 'Public display route must remain GET-only.');
$assert(!$proxy->handles('PATCH', '/v1/public/tournaments/429/live'), 'Public live route must remain GET-only.');

// Query forwarding is deliberately narrower than route matching. Only the two
// check-in display context parameters may cross the same-origin Node boundary.
$assert(
    $proxy->targetPath(
        '/v1/public/check-in-display',
        'ignored=1&club_slug=blindleia-dartklubb&screen_token=abc%2B123&another=2'
    ) === '/v1/public/check-in-display?screen_token=abc%2B123&club_slug=blindleia-dartklubb',
    'Check-in display must forward only screen_token and club_slug.'
);
$assert(
    $proxy->targetPath('/v1/public/check-in-display', 'club_slug%5B%5D=bad&screen_token%5B%5D=bad&ignored=1')
        === '/v1/public/check-in-display',
    'Array-shaped or unknown query parameters must not be forwarded.'
);
$assert(
    $proxy->targetPath('/v1/public/clubs/blindleia-dartklubb/live', 'screen_token=secret&ignored=1')
        === '/v1/public/clubs/blindleia-dartklubb/live',
    'Public live routes must not forward unrelated query parameters.'
);

echo "BackendV2PlayerLiveProxy routing OK\n";
