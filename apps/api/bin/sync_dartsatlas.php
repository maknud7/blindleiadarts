<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$configFile = dirname(__DIR__) . '/config.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "Missing API config: {$configFile}" . PHP_EOL);
    exit(1);
}

$config = require $configFile;
$packageRoots = [
    dirname(__DIR__, 3) . '/packages', // repository layout
    dirname(__DIR__, 2) . '/packages', // deployed release layout
];
$packageRoot = null;
foreach ($packageRoots as $candidate) {
    if (is_dir($candidate . '/connectors/src/DartsAtlas')) {
        $packageRoot = $candidate;
        break;
    }
}
if ($packageRoot === null) {
    fwrite(STDERR, "Unable to locate packages/connectors." . PHP_EOL);
    exit(1);
}

require_once $packageRoot . '/connectors/src/DartsAtlas/DartsAtlasHttpClient.php';
require_once $packageRoot . '/connectors/src/DartsAtlas/DartsAtlasParser.php';
require_once $packageRoot . '/connectors/src/DartsAtlas/DartsAtlasSyncService.php';

$options = getopt('', ['season:', 'tournament:', 'deep', 'max-age:']);
$seasonId = isset($options['season']) ? (string)$options['season'] : (string)($config['dartsatlas']['season_id'] ?? '');
$tournamentId = isset($options['tournament']) ? (string)$options['tournament'] : '';
$deep = array_key_exists('deep', $options);
$maxAge = isset($options['max-age']) ? max(0, (int)$options['max-age']) : 0;

if ($seasonId === '' && $tournamentId === '') {
    fwrite(STDERR, "Usage: php sync_dartsatlas.php --season=<id> [--deep] OR --tournament=<id> [--max-age=8] [--deep]" . PHP_EOL);
    exit(2);
}

$dbConfig = $config['db'] ?? [];
$db = new mysqli(
    (string)$dbConfig['host'],
    (string)$dbConfig['username'],
    (string)$dbConfig['password'],
    (string)$dbConfig['database'],
    (int)$dbConfig['port']
);
$db->set_charset('utf8mb4');

$client = new DartsAtlasHttpClient((string)($config['dartsatlas']['base_url'] ?? 'https://www.dartsatlas.com'));
$parser = new DartsAtlasParser();
$service = new DartsAtlasSyncService(
    $db,
    (string)($dbConfig['table_prefix'] ?? ''),
    (int)($config['club_id'] ?? 1),
    (string)($config['members_table'] ?? 'medlemmer'),
    $client,
    $parser
);

try {
    if ($tournamentId !== '') {
        $result = $service->syncTournamentIfStale($tournamentId, $maxAge, $deep);
    } else {
        $result = $service->syncSeason($seasonId, $deep);
    }

    fwrite(STDOUT, json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL);
} catch (Throwable $e) {
    fwrite(STDERR, json_encode([
        'ok' => false,
        'error' => $e->getMessage(),
        'type' => get_class($e),
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL);
    exit(1);
} finally {
    $db->close();
}
