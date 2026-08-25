<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function required_env_elo(string $key): string
{
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing required environment variable: {$key}");
    }
    return $value;
}

$db = new mysqli(
    required_env_elo('DB_HOST'),
    required_env_elo('DB_USERNAME'),
    required_env_elo('DB_PASSWORD'),
    required_env_elo('DB_NAME'),
    (int) required_env_elo('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = required_env_elo('DB_TABLE_PREFIX');

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$tables = [];
$result = $db->query('SHOW TABLES');
while ($row = $result->fetch_row()) {
    $tables[(string) $row[0]] = true;
}
foreach ([$prefix . 'elo_match_events', $prefix . 'elo_current_ratings'] as $table) {
    $assert(isset($tables[$table]), "Missing ELO table {$table}.");
}

$columns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}tournaments`");
while ($row = $result->fetch_assoc()) {
    $columns[(string) $row['Field']] = $row;
}
$assert(isset($columns['elo_enabled']), 'tournaments.elo_enabled is missing.');

$eventColumns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}elo_match_events`");
while ($row = $result->fetch_assoc()) {
    $eventColumns[(string) $row['Field']] = true;
}
foreach ([
    'match_id', 'season_id', 'player_a_id', 'player_b_id', 'winner_player_id',
    'rating_a_before', 'rating_b_before', 'rating_a_after', 'rating_b_after',
    'delta_a', 'delta_b', 'matches_before_a', 'matches_before_b', 'k_a', 'k_b',
    'status', 'applied_at', 'reverted_at',
] as $column) {
    $assert(isset($eventColumns[$column]), "elo_match_events.{$column} is missing.");
}

$currentColumns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}elo_current_ratings`");
while ($row = $result->fetch_assoc()) {
    $currentColumns[(string) $row['Field']] = true;
}
foreach (['season_id', 'player_id', 'rating', 'matches_played', 'last_event_id'] as $column) {
    $assert(isset($currentColumns[$column]), "elo_current_ratings.{$column} is missing.");
}

$uniqueMatchIndex = false;
$result = $db->query("SHOW INDEX FROM `{$prefix}elo_match_events`");
while ($row = $result->fetch_assoc()) {
    if ((string) $row['Column_name'] === 'match_id' && (int) $row['Non_unique'] === 0) {
        $uniqueMatchIndex = true;
        break;
    }
}
$assert($uniqueMatchIndex, 'elo_match_events.match_id must be unique.');

echo "ELO ledger schema OK\n";
