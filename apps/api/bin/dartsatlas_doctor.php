<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;

$apiRoot = dirname(__DIR__);
require $apiRoot . '/bootstrap.php';

$config = Config::load($apiRoot);
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();
$membersTable = $config->dartsAtlas()->membersTable();
$sqlconnectPath = $config->membersSqlconnectPath();

if (!preg_match('/^[A-Za-z0-9_]+$/', $membersTable)) {
    fwrite(STDERR, "Unsafe members table configured.\n");
    exit(2);
}

$requiredTables = [
    'clubs', 'seasons', 'tournaments', 'players', 'kiosks', 'tournament_players',
    'matches', 'legs', 'visits', 'external_references', 'connector_sync_jobs',
    'connector_resources', 'match_statistics', 'live_match_states',
];

$report = [
    'database' => $config->dbName(),
    'table_prefix' => $prefix,
    'ready' => true,
    'core_ready' => true,
    'member_linking_ready' => false,
    'tables' => [],
    'member_registry' => [
        'table' => $membersTable,
        'sqlconnect_path' => $sqlconnectPath,
        'sqlconnect_exists' => $sqlconnectPath !== '' && is_file($sqlconnectPath),
        'credentials_configured' => $config->membersDbConfigured(),
        'source' => 'unavailable',
        'exists' => false,
        'columns' => [],
    ],
];

$tableStmt = $db->prepare(
    'SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
);
$columnStmt = $db->prepare(
    'SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
);

foreach ($requiredTables as $shortName) {
    $tableName = $prefix . $shortName;
    $tableStmt->bind_param('s', $tableName);
    $tableStmt->execute();
    $exists = (int) ($tableStmt->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
    $report['tables'][$shortName] = $exists;
    if (!$exists) {
        $report['core_ready'] = false;
    }
}

$playersTable = $prefix . 'players';
foreach (['member_id', 'member_link_source', 'member_linked_at'] as $column) {
    $columnStmt->bind_param('ss', $playersTable, $column);
    $columnStmt->execute();
    $row = $columnStmt->get_result()->fetch_assoc() ?: null;
    $report['tables']['players_' . $column] = $row !== null;
    if ($row === null) {
        $report['core_ready'] = false;
    }
}

$tableStmt->close();
$columnStmt->close();

$membership = new MembershipDatabase($config, $database, $membersTable);
$memberDb = $membership->connection();
$report['member_registry']['source'] = $membership->source();

if ($memberDb instanceof mysqli) {
    $memberTableStmt = $memberDb->prepare(
        'SELECT COUNT(*) AS cnt FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
    );
    $memberTableStmt->bind_param('s', $membersTable);
    $memberTableStmt->execute();
    $report['member_registry']['exists'] = (int) ($memberTableStmt->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
    $memberTableStmt->close();

    $memberColumnStmt = $memberDb->prepare(
        'SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
    );
    foreach (['id', 'navn'] as $column) {
        $memberColumnStmt->bind_param('ss', $membersTable, $column);
        $memberColumnStmt->execute();
        $report['member_registry']['columns'][$column] = $memberColumnStmt->get_result()->fetch_assoc() ?: null;
    }
    $memberColumnStmt->close();

    $report['member_linking_ready'] = $report['member_registry']['exists']
        && $report['member_registry']['columns']['id'] !== null
        && $report['member_registry']['columns']['navn'] !== null;
}

$report['ready'] = $report['core_ready'];
if (!$report['member_linking_ready']) {
    $report['warning'] = 'DartsAtlas core/live is ready, but automatic member linking is disabled until local sqlconnect.php or fallback member DB access is available.';
}

fwrite(STDOUT, json_encode(
    $report,
    JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
) . PHP_EOL);

exit($report['ready'] ? 0 : 1);
