<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2TournamentProxyApplication;

$app = new BackendV2TournamentProxyApplication(dirname(__DIR__));

$yes = [
    ['GET', '/v1/clubs/1/registration-tournaments'],
    ['GET', '/v1/tournaments/9/groups'],
    ['PATCH', '/v1/tournaments/9/registration-settings'],
    ['POST', '/v1/tournaments/9/groups/draw'],
    ['POST', '/v1/tournaments/9/groups/round-robin'],
    ['POST', '/v1/tournaments/9/register'],
    ['DELETE', '/v1/tournaments/9/register'],
    ['POST', '/v1/tournaments/9/registrations'],
    ['POST', '/v1/tournaments/9/registrations/guest'],
    ['DELETE', '/v1/tournaments/9/registrations/17'],
    ['GET', '/v1/tournaments/9/wizard-plan'],
    ['PUT', '/v1/tournaments/9/wizard-plan'],
    ['PATCH', '/v1/tournaments/9/wizard-plan'],
    ['DELETE', '/v1/tournaments/9/wizard-plan'],
    ['POST', '/v1/tournaments/9/check-in'],
    ['GET', '/v1/tournaments/9/check-in-status'],
    ['POST', '/v1/tournaments/9/finish-checkin'],
    ['POST', '/v1/tournaments/9/start'],
    ['GET', '/v1/clubs/1/checkin-settings'],
    ['PATCH', '/v1/clubs/1/checkin-settings'],
    ['GET', '/v1/tournaments/9/checkin-settings'],
    ['PUT', '/v1/tournaments/9/checkin-settings'],
    ['POST', '/v1/tournaments/9/checkin-code/rotate'],
    ['POST', '/v1/tournaments/9/admin-check-in/17'],
    ['DELETE', '/v1/tournaments/9/admin-check-in/17'],
    ['GET', '/v1/tournaments/9/me/break'],
    ['POST', '/v1/tournaments/9/me/break'],
    ['GET', '/v1/me/break-context'],
    ['GET', '/v1/tournaments/9/operations'],
    ['PATCH', '/v1/tournaments/9/operations/settings'],
    ['GET', '/v1/tournaments/9/operations/boards'],
    ['PUT', '/v1/tournaments/9/operations/boards'],
    ['POST', '/v1/tournaments/9/operations/reconcile'],
    ['POST', '/v1/tournaments/9/operations/matches/22/move'],
    ['GET', '/v1/tournaments/9/playoffs'],
    ['POST', '/v1/tournaments/9/playoffs/generate'],
    ['POST', '/v1/tournaments/9/playoffs/reconcile'],
];

foreach ($yes as [$method, $path]) {
    if (!$app->handles($method, $path)) {
        fwrite(STDERR, "Expected tournament frontdoor to handle {$method} {$path}\n");
        exit(1);
    }
}

$no = [
    ['POST', '/v1/tournaments'],
    ['DELETE', '/v1/tournaments/9'],
    ['POST', '/v1/tournaments/9/wizard-plan'],
    ['POST', '/v1/tournaments/9/finish'],
    ['POST', '/v1/tournaments/9/playoffs'],
    ['GET', '/v1/tournaments/9/registrations'],
    ['DELETE', '/v1/tournaments/9/me/break'],
    ['POST', '/v1/me/break-context'],
    ['POST', '/v1/tournaments/9/operations/matches/22/start'],
    ['GET', '/v1/tournaments/9/summary'],
];

foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected tournament frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

echo "BackendV2TournamentProxy routing OK\n";
