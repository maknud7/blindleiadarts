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
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};
$column = static function (mysqli $db, string $table, string $name): ?array {
    $stmt = $db->prepare('SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
    $stmt->bind_param('ss', $table, $name);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    return $row;
};

$tournaments = $prefix . 'tournaments';
$registrations = $prefix . 'tournament_players';
$groups = $prefix . 'tournament_groups';
$groupPlayers = $prefix . 'tournament_group_players';
$matches = $prefix . 'matches';
$status = $column($db, $registrations, 'status');

$result = [
    'tournament_groups_table' => $tableExists($db, $groups),
    'tournament_group_players_table' => $tableExists($db, $groupPlayers),
    'registration_opens_at' => $column($db, $tournaments, 'registration_opens_at') !== null,
    'registration_closes_at' => $column($db, $tournaments, 'registration_closes_at') !== null,
    'max_players' => $column($db, $tournaments, 'max_players') !== null,
    'group_draw_mode' => $column($db, $tournaments, 'group_draw_mode') !== null,
    'group_draw_seed' => $column($db, $tournaments, 'group_draw_seed') !== null,
    'registration_seed_rating' => $column($db, $registrations, 'seed_rating') !== null,
    'registration_source' => $column($db, $registrations, 'registration_source') !== null,
    'waitlist_status' => $status !== null && str_contains((string) $status['COLUMN_TYPE'], "'waitlisted'"),
    'match_group_id' => $column($db, $matches, 'tournament_group_id') !== null,
    'match_round_number' => $column($db, $matches, 'round_number') !== null,
];
$result['ready'] = !in_array(false, $result, true);

echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($result['ready'] ? 0 : 1);
