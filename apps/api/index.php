<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Application;
use Blindleia\Dartkiosk\Api\MatchScoringApplication;
use Blindleia\Dartkiosk\Api\PlayerPortalApplication;
use Blindleia\Dartkiosk\Api\TournamentFeatureApplication;

require __DIR__ . '/bootstrap.php';

$tournamentFeatures = new TournamentFeatureApplication(__DIR__);
if ($tournamentFeatures->run()) {
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
