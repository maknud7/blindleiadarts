<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloLedgerService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') {
    exit(2);
}

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';

$configDir = isset($argv[1]) && trim((string) $argv[1]) !== ''
    ? rtrim((string) $argv[1], '/\\')
    : $root . '/apps/api';

$config = Config::load($configDir);
$database = new Database($config);
$service = new EloLedgerService($database);
$result = $service->reconcileGuestMatches();

echo 'ELO_GUEST_RECONCILE_OK=yes' . PHP_EOL;
echo 'ELO_GUEST_EVENTS_REVERTED=' . (int) $result['reverted_events'] . PHP_EOL;
echo 'ELO_GUEST_SEASONS_REBUILT=' . (int) $result['rebuilt_seasons'] . PHP_EOL;
