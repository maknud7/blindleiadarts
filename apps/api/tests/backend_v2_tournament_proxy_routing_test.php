<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2TournamentProxyApplication;

$app = new BackendV2TournamentProxyApplication(dirname(__DIR__));

$yes = [
    ['GET', '/v1/clubs/1/tournaments'],
    ['POST', '/v1/clubs/1/tournaments'],
    ['GET', '/v1/tournaments/9'],
    ['GET', '/v1/tournaments/9/elo-settings'],
    ['PUT', '/v1/tournaments/9/elo-settings'],
    ['PATCH', '/v1/tournaments/9/elo-settings'],
    ['GET', '/v1/tournaments/9/matches'],
    ['POST', '/v1/tournaments/9/matches'],
    ['GET', '/v1/tournaments/9/board-assignments'],
    ['PUT', '/v1/tournaments/9/board-assignments'],
    ['POST', '/v1/tournaments/9/auto-assign'],
    ['POST', '/v1/matches/22/assign-kiosk'],
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

    ['POST', '/v1/clubs/1/seasons'],
    ['PUT', '/v1/seasons/8'],
    ['PATCH', '/v1/seasons/8'],
    ['POST', '/v1/seasons/8/activate'],
    ['POST', '/v1/seasons/8/complete'],

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
    ['DELETE', '/v1/tournaments/9/hard-delete'],
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
    ['PATCH', '/v1/tournaments/9'],
    ['DELETE', '/v1/tournaments/9'],
    ['POST', '/v1/tournaments/9/elo-settings'],
    ['DELETE', '/v1/tournaments/9/elo-settings'],

    // Season reads stay on the player/live read frontdoor. Unsupported season
    // verbs must keep falling through to legacy until explicitly migrated.
    ['GET', '/v1/clubs/1/seasons'],
    ['GET', '/v1/seasons/8'],
    ['GET', '/v1/seasons/8/standings'],
    ['DELETE', '/v1/seasons/8'],
    ['PUT', '/v1/seasons/8/activate'],

    ['POST', '/v1/tournaments/9/wizard-plan'],
    ['POST', '/v1/tournaments/9/finish'],
    ['POST', '/v1/tournaments/9/playoffs'],
    ['GET', '/v1/tournaments/9/registrations'],
    ['DELETE', '/v1/tournaments/9/me/break'],
    ['POST', '/v1/me/break-context'],
    ['POST', '/v1/tournaments/9/operations/matches/22/start'],
    ['GET', '/v1/tournaments/9/hard-delete'],
    ['POST', '/v1/tournaments/9/hard-delete'],
    ['GET', '/v1/tournaments/9/summary'],
];

foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected tournament frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

echo "BackendV2TournamentProxy routing OK\n";
