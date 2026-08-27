<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing {$key}");
    }
    return $value;
};

$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_prod_') {
    throw new RuntimeException("Refusing production reset for unexpected prefix: {$prefix}");
}
if ($required('CONFIRM_PROD_RESET') !== 'DELETE_TOURNAMENT_DATA') {
    throw new RuntimeException('Production reset confirmation token is missing.');
}

$db = mysqli_init();
if ($db === false) {
    throw new RuntimeException('Could not initialize mysqli.');
}
$db->real_connect(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$tableExists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$countRows = static function (mysqli $db, string $table, callable $tableExists): int {
    if (!$tableExists($db, $table)) {
        return 0;
    }
    $result = $db->query("SELECT COUNT(*) AS c FROM `{$table}`");
    $count = (int) ($result->fetch_assoc()['c'] ?? 0);
    $result->free();
    return $count;
};

$deleteAll = static function (mysqli $db, string $table, callable $tableExists): int {
    if (!$tableExists($db, $table)) {
        return 0;
    }
    $before = 0;
    $result = $db->query("SELECT COUNT(*) AS c FROM `{$table}`");
    $before = (int) ($result->fetch_assoc()['c'] ?? 0);
    $result->free();
    if ($before > 0) {
        $db->query("DELETE FROM `{$table}`");
    }
    return $before;
};

$beforeCore = [];
foreach (['seasons','tournaments','tournament_players','matches','legs','visits','ranking_snapshots'] as $suffix) {
    $beforeCore[$suffix] = $countRows($db, $prefix . $suffix, $tableExists);
}
fwrite(STDOUT, 'Production tournament reset BEFORE: ' . json_encode($beforeCore, JSON_UNESCAPED_SLASHES) . PHP_EOL);

$deleted = [];
$db->begin_transaction();
try {
    // Tables derived from tournament/match runtime. Keep club identity, players,
    // users, members, kiosks, screens, settings and Scolia board configuration.
    foreach ([
        'season_ranking_events',
        'elo_current_ratings',
        'elo_match_events',
        'tournament_playoff_nodes',
        'tournament_playoff_entries',
        'tournament_playoffs',
        'tournament_player_breaks',
        'tournament_group_players',
        'tournament_groups',
        'tournament_summaries',
        'tournament_board_reservations',
        'tournament_kiosks',
        'match_statistics',
        'live_match_states',
        'ranking_snapshots',
        'scolia_visit_buffers',
        'scolia_shadow_visits',
        'visits',
        'legs',
        'matches',
        'tournament_players',
        'tournaments',
        'seasons',
    ] as $suffix) {
        $deleted[$suffix] = $deleteAll($db, $prefix . $suffix, $tableExists);
    }

    // Remove only legacy DartsAtlas connector history/references. Player rows are
    // intentionally preserved because they are also canonical member identities.
    $externalReferences = $prefix . 'external_references';
    if ($tableExists($db, $externalReferences)) {
        $db->query("DELETE FROM `{$externalReferences}` WHERE LOWER(`external_system`) LIKE '%atlas%'");
        $deleted['external_references_atlas'] = $db->affected_rows;
    }

    $syncJobs = $prefix . 'connector_sync_jobs';
    if ($tableExists($db, $syncJobs)) {
        $db->query("DELETE FROM `{$syncJobs}` WHERE LOWER(`external_system`) LIKE '%atlas%'");
        $deleted['connector_sync_jobs_atlas'] = $db->affected_rows;
    }

    // Scolia diagnostics tied to historical matches must not survive the reset.
    foreach (['scolia_events', 'scolia_incidents'] as $suffix) {
        $table = $prefix . $suffix;
        if (!$tableExists($db, $table)) {
            continue;
        }
        $columnStmt = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME="match_id" LIMIT 1');
        $columnStmt->bind_param('s', $table);
        $columnStmt->execute();
        $hasMatchId = $columnStmt->get_result()->fetch_assoc() !== null;
        $columnStmt->close();
        if ($hasMatchId) {
            $db->query("DELETE FROM `{$table}` WHERE `match_id` IS NOT NULL");
            $deleted[$suffix . '_match_rows'] = $db->affected_rows;
        }
    }

    foreach (['seasons','tournaments','tournament_players','matches','legs','visits','ranking_snapshots'] as $suffix) {
        $table = $prefix . $suffix;
        if (!$tableExists($db, $table)) {
            continue;
        }
        $remaining = $countRows($db, $table, $tableExists);
        if ($remaining !== 0) {
            throw new RuntimeException("Production reset failed: {$table} still contains {$remaining} row(s).");
        }
    }

    $db->commit();
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}

fwrite(STDOUT, 'Production tournament reset DELETED: ' . json_encode($deleted, JSON_UNESCAPED_SLASHES) . PHP_EOL);

$afterCore = [];
foreach (['seasons','tournaments','tournament_players','matches','legs','visits','ranking_snapshots'] as $suffix) {
    $afterCore[$suffix] = $countRows($db, $prefix . $suffix, $tableExists);
}
fwrite(STDOUT, 'Production tournament reset AFTER: ' . json_encode($afterCore, JSON_UNESCAPED_SLASHES) . PHP_EOL);
