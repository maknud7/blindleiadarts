<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloCanonicalReplayService;
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
if ($config->appEnv() !== 'test' || $config->dbTablePrefix() !== 'bd_test_') {
    throw new RuntimeException('Canonical replay is restricted to TEST / bd_test_.');
}

$database = new Database($config);
$result = (new EloCanonicalReplayService($database))->replay();

echo 'ELO_CANONICAL_REPLAY_OK=yes' . PHP_EOL;
foreach ($result as $key => $value) {
    echo 'ELO_' . strtoupper($key) . '=' . (int) $value . PHP_EOL;
}
