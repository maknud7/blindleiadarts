<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2ClubAdminProxyApplication;

$app = new BackendV2ClubAdminProxyApplication(dirname(__DIR__));

if (!$app->handles('POST', '/v1/clubs')) {
    fwrite(STDERR, "Expected club-admin frontdoor to handle POST /v1/clubs\n");
    exit(1);
}

$no = [
    ['GET', '/v1/clubs'],
    ['PUT', '/v1/clubs'],
    ['PATCH', '/v1/clubs'],
    ['DELETE', '/v1/clubs'],
    ['POST', '/v1/clubs/1'],
    ['POST', '/v1/clubs/1/players'],
    ['POST', '/v1/clubs/1/kiosks'],
];
foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected club-admin frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

echo "BackendV2ClubAdminProxy routing OK\n";
