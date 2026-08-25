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

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};
$table = $prefix . 'tournament_player_breaks';
$result = $db->query("SHOW TABLES LIKE '" . $db->real_escape_string($table) . "'");
$assert($result->fetch_row() !== null, 'Missing tournament_player_breaks table.');

$columns = [];
$result = $db->query("SHOW COLUMNS FROM `{$table}`");
while ($row = $result->fetch_assoc()) $columns[(string) $row['Field']] = true;
foreach (['tournament_id','player_id','after_match_id','status','requested_at','starts_at','ends_at'] as $column) {
    $assert(isset($columns[$column]), "tournament_player_breaks.{$column} is missing.");
}

$status = $db->query("SHOW COLUMNS FROM `{$prefix}tournament_players` LIKE 'status'")->fetch_assoc();
$assert($status !== null && str_contains((string) $status['Type'], "'paused'"), 'tournament_players.status is missing paused.');

echo "Player break schema OK\n";
