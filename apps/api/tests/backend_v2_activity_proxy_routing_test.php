<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2ActivityProxyApplication;

$app = new BackendV2ActivityProxyApplication(dirname(__DIR__));

$yes = [
    ['POST', '/v1/activity'],
    ['GET', '/v1/activity/session'],
    ['GET', '/v1/clubs/1/activity'],
    ['GET', '/v1/platform/activity'],
];
foreach ($yes as [$method, $path]) {
    if (!$app->handles($method, $path)) {
        fwrite(STDERR, "Expected activity frontdoor to handle {$method} {$path}\n");
        exit(1);
    }
}

$no = [
    ['GET', '/v1/activity'],
    ['POST', '/v1/activity/session'],
    ['POST', '/v1/clubs/1/activity'],
    ['GET', '/v1/clubs/1/elo'],
    ['GET', '/v1/platform'],
];
foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected activity frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

if ($app->targetPath('/v1/clubs/1/activity', 'days=45&token=secret') !== '/v1/clubs/1/activity?days=45') {
    fwrite(STDERR, "Activity frontdoor must forward only the days query parameter.\n");
    exit(1);
}
if ($app->targetPath('/v1/activity/session', 'days=45') !== '/v1/activity/session') {
    fwrite(STDERR, "Session route must not forward summary query parameters.\n");
    exit(1);
}

echo "BackendV2ActivityProxy routing OK\n";
