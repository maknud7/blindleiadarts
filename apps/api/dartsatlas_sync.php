<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

/** @var array{config:array<string,mixed>,db:mysqli,prefix:string,adapter:DartsAtlasLiveAdapter} $app */
$app = require __DIR__ . '/bootstrap.php';
$config = $app['config'];
$adapter = $app['adapter'];

$options = getopt('', ['tournament::', 'source::', 'season::']);
$dartsAtlasConfig = is_array($config['dartsatlas'] ?? null) ? $config['dartsatlas'] : [];

$tournamentId = trim((string) ($options['tournament'] ?? ($dartsAtlasConfig['tournament_id'] ?? '')));
$sourceUrl = trim((string) ($options['source'] ?? ($dartsAtlasConfig['source_url'] ?? '')));
$seasonId = trim((string) ($options['season'] ?? ($dartsAtlasConfig['season_id'] ?? '')));
$seasonId = $seasonId === '' ? null : $seasonId;

try {
    if ($tournamentId !== '') {
        $summary = $adapter->syncTournament($tournamentId, $seasonId);
        fwrite(STDOUT, json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL);
        exit(0);
    }

    if ($sourceUrl === '') {
        throw new RuntimeException(
            'Set DARTSATLAS_TOURNAMENT_ID/DARTSATLAS_SOURCE_URL or use --tournament/--source.'
        );
    }

    $discovery = $adapter->discover($sourceUrl);
    $ids = $discovery['tournament_ids'];

    if ($ids === []) {
        throw new RuntimeException('No Darts Atlas tournament links were discovered from the configured source.');
    }

    $max = max(1, (int) ($dartsAtlasConfig['max_tournaments_per_run'] ?? 3));
    $ids = array_slice($ids, 0, $max);

    $summaries = [];
    foreach ($ids as $id) {
        $summaries[] = $adapter->syncTournament($id, $seasonId);
    }

    fwrite(
        STDOUT,
        json_encode(
            [
                'discovery' => $discovery,
                'synced' => $summaries,
            ],
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        ) . PHP_EOL
    );
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}
