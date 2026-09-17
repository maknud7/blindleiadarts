<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2ClubAdminProxyApplication;

$app = new BackendV2ClubAdminProxyApplication(dirname(__DIR__));

foreach ([
    ['POST', '/v1/clubs'],
    ['POST', '/v1/public/kiosk/connect'],
    ['GET', '/v1/health'],
    ['GET', '/v1/clubs/1/match-calls'],
    ['GET', '/v1/clubs/90071992547409931/match-calls'],
] as [$method, $path]) {
    if (!$app->handles($method, $path)) {
        fwrite(STDERR, "Expected club-admin frontdoor to handle {$method} {$path}\n");
        exit(1);
    }
}

$no = [
    ['GET', '/v1/clubs'],
    ['PUT', '/v1/clubs'],
    ['PATCH', '/v1/clubs'],
    ['DELETE', '/v1/clubs'],
    ['POST', '/v1/clubs/1'],
    ['POST', '/v1/clubs/1/players'],
    ['POST', '/v1/clubs/1/kiosks'],
    ['POST', '/v1/clubs/1/match-calls'],
    ['GET', '/v1/clubs/0/match-calls'],
    ['GET', '/v1/public/kiosk/connect'],
    ['POST', '/v1/health'],
];
foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected club-admin frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

$targets = [
    ['/v1/health', 'deep=1&cb=123', '/v1/health?deep=1'],
    ['/v1/health', 'deep=0&foo=bar', '/v1/health'],
    ['/v1/health', 'foo=bar', '/v1/health'],
    ['/v1/clubs/1/match-calls', 'deep=1', '/v1/clubs/1/match-calls'],
];
foreach ($targets as [$path, $query, $expected]) {
    $actual = $app->targetPath($path, $query);
    if ($actual !== $expected) {
        fwrite(STDERR, "Unexpected club-admin target path: {$actual}; expected {$expected}\n");
        exit(1);
    }
}

echo "BackendV2ClubAdminProxy routing OK\n";