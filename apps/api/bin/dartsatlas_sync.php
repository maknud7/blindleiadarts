<?php

declare(strict_types=1);

$apiDir = dirname(__DIR__);
$packageRoots = [
    dirname(__DIR__, 3) . '/packages', // repository: /repo/apps/api/bin -> /repo/packages
    dirname(__DIR__, 2) . '/packages', // release: /release/api/bin -> /release/packages
];
$packageRoot = null;
foreach ($packageRoots as $candidate) {
    if (is_file($candidate . '/connectors/DartsAtlas/DartsAtlasSyncService.php')) {
        $packageRoot = $candidate;
        break;
    }
}
if ($packageRoot === null) {
    fwrite(STDERR, "Unable to locate packages/connectors/DartsAtlas.\n");
    exit(2);
}

require_once $packageRoot . '/connectors/DartsAtlas/DartsAtlasHttpClient.php';
require_once $packageRoot . '/connectors/DartsAtlas/DartsAtlasHtmlParser.php';
require_once $packageRoot . '/connectors/DartsAtlas/DartsAtlasRepository.php';
require_once $packageRoot . '/connectors/DartsAtlas/DartsAtlasSyncService.php';

$options = getopt('', [
    'config::',
    'season-id::',
    'tournament-id::',
    'club-id::',
    'local-season-id::',
    'members-table::',
    'watch',
    'interval::',
]);

$configPath = (string) ($options['config'] ?? getenv('BLINDLEIA_API_CONFIG') ?: ($apiDir . '/config.php'));
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing API config: {$configPath}\n");
    exit(2);
}

$config = require $configPath;
if (!is_array($config) || !isset($config['db']) || !is_array($config['db'])) {
    fwrite(STDERR, "Invalid API config.\n");
    exit(2);
}

$dbConfig = $config['db'];
$da = isset($config['dartsatlas']) && is_array($config['dartsatlas']) ? $config['dartsatlas'] : [];

$seasonId = trim((string) ($options['season-id'] ?? $da['season_id'] ?? ''));
$tournamentId = trim((string) ($options['tournament-id'] ?? $da['tournament_id'] ?? ''));
$clubId = (int) ($options['club-id'] ?? $da['club_id'] ?? 0);
$localSeasonRaw = $options['local-season-id'] ?? $da['local_season_id'] ?? null;
$localSeasonId = ($localSeasonRaw === null || $localSeasonRaw === '') ? null : (int) $localSeasonRaw;
$membersTable = trim((string) ($options['members-table'] ?? $da['members_table'] ?? 'medlemmer'));
$watch = array_key_exists('watch', $options);
$interval = max(5, (int) ($options['interval'] ?? $da['poll_interval_seconds'] ?? 8));
$userAgent = trim((string) ($da['user_agent'] ?? 'BlindleiaDarts/1.0'));

if ($seasonId === '' || $clubId <= 0) {
    fwrite(STDERR, "DartsAtlas season-id and a positive club-id are required.\n");
    exit(2);
}
if ($watch && $tournamentId === '') {
    fwrite(STDERR, "--watch requires --tournament-id. This prevents polling the entire season every cycle.\n");
    exit(2);
}

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db = new mysqli(
    (string) $dbConfig['host'],
    (string) $dbConfig['username'],
    (string) $dbConfig['password'],
    (string) $dbConfig['database'],
    (int) ($dbConfig['port'] ?? 3306),
);
$db->set_charset('utf8mb4');

$repository = new DartsAtlasRepository(
    $db,
    (string) ($dbConfig['table_prefix'] ?? ''),
    $membersTable,
);
$service = new DartsAtlasSyncService(
    new DartsAtlasHttpClient($userAgent),
    new DartsAtlasHtmlParser(),
    $repository,
    $clubId,
    $localSeasonId,
);

$run = static function () use ($service, $seasonId, $tournamentId): void {
    $summary = $service->syncSeason($seasonId, $tournamentId !== '' ? $tournamentId : null);
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
    fwrite(STDERR, sprintf("DartsAtlas sync failed: %s\n", $error->getMessage()));
    exit(1);
}
