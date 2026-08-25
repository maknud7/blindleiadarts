<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Application;
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

$app = new Application(__DIR__);
$app->run();
