<?php

declare(strict_types=1);

$root = dirname(__DIR__, 3);
$options = getopt('', ['config::', 'members-table::']);
$configPath = (string) ($options['config'] ?? getenv('BLINDLEIA_API_CONFIG') ?: ($root . '/apps/api/config.php'));

if (!is_file($configPath)) {
    fwrite(STDERR, "Missing API config: {$configPath}\n");
    exit(2);
}

$config = require $configPath;
$dbConfig = $config['db'] ?? null;
if (!is_array($dbConfig)) {
    fwrite(STDERR, "Invalid database config.\n");
    exit(2);
}

$membersTable = trim((string) ($options['members-table'] ?? $config['dartsatlas']['members_table'] ?? 'medlemmer'));
$prefix = (string) ($dbConfig['table_prefix'] ?? '');
if (!preg_match('/^[A-Za-z0-9_]*$/', $prefix) || !preg_match('/^[A-Za-z0-9_]+$/', $membersTable)) {
    fwrite(STDERR, "Unsafe table identifier in config.\n");
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

$required = [
    'clubs', 'seasons', 'tournaments', 'players', 'tournament_players', 'matches', 'legs', 'visits',
    'ranking_snapshots', 'external_references', 'connector_sync_jobs', 'connector_resources',
    'match_statistics', 'live_match_states',
];

$report = [
    'database' => (string) $dbConfig['database'],
    'table_prefix' => $prefix,
    'tables' => [],
    'member_registry' => [
        'table' => $membersTable,
        'exists' => false,
        'required_columns' => [],
    ],
    'ready' => true,
];

$tableStmt = $db->prepare(
    'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?'
);
$columnStmt = $db->prepare(
    'SELECT data_type, column_type, is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1'
);

foreach ($required as $name) {
    $tableName = $prefix . $name;
    $tableStmt->bind_param('s', $tableName);
    $tableStmt->execute();
    $exists = (int) ($tableStmt->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
    $report['tables'][$name] = ['table' => $tableName, 'exists' => $exists];
    if (!$exists) {
        $report['ready'] = false;
    }
}

$tableStmt->bind_param('s', $membersTable);
$tableStmt->execute();
$report['member_registry']['exists'] = (int) ($tableStmt->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
if (!$report['member_registry']['exists']) {
    $report['ready'] = false;
}

foreach (['id', 'navn'] as $column) {
    $columnStmt->bind_param('ss', $membersTable, $column);
    $columnStmt->execute();
    $row = $columnStmt->get_result()->fetch_assoc();
    $report['member_registry']['required_columns'][$column] = $row ?: null;
    if (!$row) {
        $report['ready'] = false;
    }
}

$playersTable = $prefix . 'players';
if (!empty($report['tables']['players']['exists'])) {
    foreach (['member_id', 'member_link_source', 'member_linked_at'] as $column) {
        $columnStmt->bind_param('ss', $playersTable, $column);
        $columnStmt->execute();
        $row = $columnStmt->get_result()->fetch_assoc();
        $report['tables']['players']['columns'][$column] = $row ?: null;
        if (!$row) {
            $report['ready'] = false;
        }
    }
}

$tableStmt->close();
$columnStmt->close();
$db->close();

fwrite(STDOUT, json_encode(
    $report,
    JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
) . PHP_EOL);

exit($report['ready'] ? 0 : 1);
