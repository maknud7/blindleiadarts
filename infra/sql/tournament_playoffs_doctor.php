<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { exit(2); }
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$get = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') { throw new RuntimeException('Missing env: ' . $key); }
    return $value;
};
$db = new mysqli($get('DB_HOST'), $get('DB_USERNAME'), $get('DB_PASSWORD'), $get('DB_NAME'), (int) $get('DB_PORT'));
$db->set_charset('utf8mb4');
$prefix = getenv('DB_TABLE_PREFIX') ?: 'bd_test_';
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) { throw new RuntimeException('Invalid prefix'); }

$tableExists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND TABLE_TYPE="BASE TABLE" LIMIT 1');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $ok = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $ok;
};
$columnExists = static function (mysqli $db, string $table, string $column): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $ok = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $ok;
};

$playoffs = $prefix . 'tournament_playoffs';
$entries = $prefix . 'tournament_playoff_entries';
$nodes = $prefix . 'tournament_playoff_nodes';
$result = [
    'playoffs_table' => $tableExists($db, $playoffs),
    'entries_table' => $tableExists($db, $entries),
    'nodes_table' => $tableExists($db, $nodes),
    'playoff_bracket_size' => $columnExists($db, $playoffs, 'bracket_size'),
    'playoff_champion' => $columnExists($db, $playoffs, 'champion_player_id'),
    'entry_seed' => $columnExists($db, $entries, 'seed_number'),
    'entry_source_group' => $columnExists($db, $entries, 'source_group_id'),
    'node_match' => $columnExists($db, $nodes, 'match_id'),
    'node_winner' => $columnExists($db, $nodes, 'winner_player_id'),
];
$result['ready'] = !in_array(false, $result, true);
echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($result['ready'] ? 0 : 1);
