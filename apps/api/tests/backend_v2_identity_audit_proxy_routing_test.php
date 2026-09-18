<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2IdentityAuditProxyApplication;

$app = new BackendV2IdentityAuditProxyApplication(dirname(__DIR__));

$yes = [
    ['GET', '/v1/player-identities/history'],
    ['GET', '/v1/player-identities/health'],
    ['GET', '/v1/clubs/1/player-identities/duplicates'],
    ['POST', '/v1/clubs/1/player-identities/preview'],
    ['POST', '/v1/clubs/1/player-identities/merge'],
];
foreach ($yes as [$method, $path]) {
    if (!$app->handles($method, $path)) {
        fwrite(STDERR, "Expected identity-audit frontdoor to handle {$method} {$path}\n");
        exit(1);
    }
}

$no = [
    ['POST', '/v1/player-identities/history'],
    ['POST', '/v1/player-identities/health'],
    ['GET', '/v1/player-identities/preview'],
    ['POST', '/v1/clubs/1/player-identities/duplicates'],
    ['GET', '/v1/clubs/1/player-identities/preview'],
    ['GET', '/v1/clubs/1/player-identities/merge'],
];
foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected identity-audit frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

if ($app->targetPath('/v1/player-identities/history', 'limit=25&secret=ignore') !== '/v1/player-identities/history?limit=25') {
    fwrite(STDERR, "Identity-audit history query allowlist failed.\n");
    exit(1);
}
if ($app->targetPath('/v1/player-identities/health', 'limit=25') !== '/v1/player-identities/health') {
    fwrite(STDERR, "Identity-audit health must not forward query parameters.\n");
    exit(1);
}
if ($app->targetPath('/v1/clubs/1/player-identities/duplicates', 'anything=ignored') !== '/v1/clubs/1/player-identities/duplicates') {
    fwrite(STDERR, "Identity diagnostics must not forward query parameters.\n");
    exit(1);
}

echo "BackendV2IdentityAuditProxy routing OK\n";
