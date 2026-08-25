<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Application;
use Blindleia\Dartkiosk\Api\EloApplication;
use Blindleia\Dartkiosk\Api\MatchScoringApplication;
use Blindleia\Dartkiosk\Api\PlayerBreakApplication;
use Blindleia\Dartkiosk\Api\PlayerPortalApplication;
use Blindleia\Dartkiosk\Api\TournamentFeatureApplication;
use Blindleia\Dartkiosk\Api\TournamentOperationsApplication;
use Blindleia\Dartkiosk\Api\TournamentPlayoffApplication;

require __DIR__ . '/bootstrap.php';

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