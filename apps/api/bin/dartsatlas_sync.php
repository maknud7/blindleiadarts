<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Service\DartsAtlasSyncService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;

$apiRoot = dirname(__DIR__);
require $apiRoot . '/bootstrap.php';

$options = getopt('', [
    'season-id::',
    'tournament-id::',
    'watch',
    'interval::',
]);

$config = Config::load($apiRoot);
$dartsAtlas = $config->dartsAtlas();
$seasonId = trim((string) ($options['season-id'] ?? $dartsAtlas->seasonId()));
$tournamentId = trim((string) ($options['tournament-id'] ?? $dartsAtlas->tournamentId()));
$watch = array_key_exists('watch', $options);
$interval = max(5, (int) ($options['interval'] ?? $dartsAtlas->pollIntervalSeconds()));

if ($seasonId === '' || $dartsAtlas->clubId() <= 0) {
    fwrite(STDERR, "DartsAtlas season_id and club_id must be configured.\n");
    exit(2);
}

if ($watch && $tournamentId === '') {
    fwrite(STDERR, "--watch requires a tournament id so the entire season is not polled continuously.\n");
    exit(2);
}

$database = new Database($config);
$repository = new DartsAtlasRepository($database, $dartsAtlas->membersTable());
$service = new DartsAtlasSyncService(
    new DartsAtlasHttpClient($dartsAtlas->userAgent()),
    new DartsAtlasParser(),
    $repository,
    $dartsAtlas,
);

$run = static function () use ($service, $seasonId, $tournamentId): void {
    $summary = $service->sync($seasonId, $tournamentId !== '' ? $tournamentId : null);
    fwrite(STDOUT, json_encode(
        $summary,
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
    ) . PHP_EOL);
};

try {
    do {
        $run();
        if ($watch) {
            sleep($interval);
        }
    } while ($watch);
} catch (Throwable $error) {
    fwrite(STDERR, 'DartsAtlas sync failed: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
