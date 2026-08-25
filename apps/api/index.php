<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Application;
use Blindleia\Dartkiosk\Api\EloApplication;
use Blindleia\Dartkiosk\Api\MatchScoringApplication;
use Blindleia\Dartkiosk\Api\PlayerBreakApplication;
use Blindleia\Dartkiosk\Api\PlayerPortalApplication;
use Blindleia\Dartkiosk\Api\ScoliaApplication;
use Blindleia\Dartkiosk\Api\TournamentCheckinApplication;
use Blindleia\Dartkiosk\Api\TournamentFeatureApplication;
use Blindleia\Dartkiosk\Api\TournamentOperationsApplication;
use Blindleia\Dartkiosk\Api\TournamentPlayoffApplication;
use Blindleia\Dartkiosk\Api\TournamentWizardApplication;

require __DIR__ . '/bootstrap.php';

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
