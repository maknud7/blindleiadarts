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
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();

if ($dartsAtlas->clubId() <= 0) {
    $slug = trim($config->screenDefaultClubSlug());
    if ($slug === '') {
        fwrite(STDERR, "DartsAtlas club_id is not configured and screen.default_club_slug is empty.\n");
        exit(2);
    }

    $clubsTable = $prefix . 'clubs';
    $statement = $db->prepare("SELECT id FROM `{$clubsTable}` WHERE slug = ? LIMIT 1");
    $statement->bind_param('s', $slug);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc();
    $statement->close();

    if (!$row) {
        fwrite(STDERR, "Could not resolve DartsAtlas club from screen.default_club_slug.\n");
        exit(2);
    }

    $dartsAtlas = $dartsAtlas->withClubId((int) $row['id']);
}

if ($dartsAtlas->localSeasonId() === null) {
    $seasonsTable = $prefix . 'seasons';
    $statement = $db->prepare(
        "SELECT id FROM `{$seasonsTable}` WHERE club_id = ? ORDER BY is_active DESC, id DESC LIMIT 1"
    );
    $clubId = $dartsAtlas->clubId();
    $statement->bind_param('i', $clubId);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc();
    $statement->close();

    if ($row) {
        $dartsAtlas = $dartsAtlas->withLocalSeasonId((int) $row['id']);
    }
}

$seasonId = trim((string) ($options['season-id'] ?? $dartsAtlas->seasonId()));
$tournamentId = trim((string) ($options['tournament-id'] ?? $dartsAtlas->tournamentId()));
$watch = array_key_exists('watch', $options);
$interval = max(5, (int) ($options['interval'] ?? $dartsAtlas->pollIntervalSeconds()));

if ($seasonId === '') {
    fwrite(STDERR, "DartsAtlas season_id must be configured or passed with --season-id.\n");
    exit(2);
}

if ($watch && $tournamentId === '') {
    fwrite(STDERR, "--watch requires a tournament id so the entire season is not polled continuously.\n");
    exit(2);
}

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
