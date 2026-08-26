<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\ActivityApplication;
use Blindleia\Dartkiosk\Api\Application;
use Blindleia\Dartkiosk\Api\EloApplication;
use Blindleia\Dartkiosk\Api\EmailAuthApplication;
use Blindleia\Dartkiosk\Api\MatchScoringApplication;
use Blindleia\Dartkiosk\Api\PasswordResetApplication;
use Blindleia\Dartkiosk\Api\PlayerBreakApplication;
use Blindleia\Dartkiosk\Api\PlayerPortalApplication;
use Blindleia\Dartkiosk\Api\ScoliaApplication;
use Blindleia\Dartkiosk\Api\SeasonApplication;
use Blindleia\Dartkiosk\Api\TournamentCheckinApplication;
use Blindleia\Dartkiosk\Api\TournamentFeatureApplication;
use Blindleia\Dartkiosk\Api\TournamentFlowApplication;
use Blindleia\Dartkiosk\Api\TournamentOperationsApplication;
use Blindleia\Dartkiosk\Api\TournamentPlayoffApplication;
use Blindleia\Dartkiosk\Api\TournamentWizardApplication;

require __DIR__ . '/bootstrap.php';

// A production-installed board terminal may opt into the isolated test runtime.
// Only the canonical production kiosk origin is allowed to call the test API cross-origin.
$origin = trim((string) ($_SERVER['HTTP_ORIGIN'] ?? ''));
if ($origin === 'https://dart.ingenting.org') {
    header('Access-Control-Allow-Origin: https://dart.ingenting.org');
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Kiosk-Pairing-Token, X-Scolia-Bridge-Secret');
    header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        return;
    }
}

$activity = new ActivityApplication(__DIR__);
if ($activity->run()) {
    return;
}

$passwordReset = new PasswordResetApplication(__DIR__);
if ($passwordReset->run()) {
    return;
}

$emailAuth = new EmailAuthApplication(__DIR__);
if ($emailAuth->run()) {
    return;
}

$scolia = new ScoliaApplication(__DIR__);
if ($scolia->run()) {
    return;
}

$checkin = new TournamentCheckinApplication(__DIR__);
if ($checkin->run()) {
    return;
}

$wizard = new TournamentWizardApplication(__DIR__);
if ($wizard->run()) {
    return;
}

$tournamentFlow = new TournamentFlowApplication(__DIR__);
if ($tournamentFlow->run()) {
    return;
}

$tournamentFeatures = new TournamentFeatureApplication(__DIR__);
if ($tournamentFeatures->run()) {
    return;
}

$playoffs = new TournamentPlayoffApplication(__DIR__);
if ($playoffs->run()) {
    return;
}

$playerBreaks = new PlayerBreakApplication(__DIR__);
if ($playerBreaks->run()) {
    return;
}

$operations = new TournamentOperationsApplication(__DIR__);
if ($operations->run()) {
    return;
}

$seasons = new SeasonApplication(__DIR__);
if ($seasons->run()) {
    return;
}

$elo = new EloApplication(__DIR__);
if ($elo->run()) {
    return;
}

$playerPortal = new PlayerPortalApplication(__DIR__);
if ($playerPortal->run()) {
    return;
}

$matchScoring = new MatchScoringApplication(__DIR__);
if ($matchScoring->run()) {
    return;
}

$app = new Application(__DIR__);
$app->run();
