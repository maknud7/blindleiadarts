<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function required_env_operations(string $key): string
{
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing required environment variable: {$key}");
    }
    return $value;
}

$db = new mysqli(
    required_env_operations('DB_HOST'),
    required_env_operations('DB_USERNAME'),
    required_env_operations('DB_PASSWORD'),
    required_env_operations('DB_NAME'),
    (int) required_env_operations('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = required_env_operations('DB_TABLE_PREFIX');

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$columns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}tournaments`");
while ($row = $result->fetch_assoc()) {
    $columns[(string) $row['Field']] = $row;
}
$assert(isset($columns['auto_assign_enabled']), 'tournaments.auto_assign_enabled is missing.');
$assert(str_contains(strtolower((string) $columns['auto_assign_enabled']['Type']), 'tinyint'), 'auto_assign_enabled must be a tinyint flag.');
$assert((string) ($columns['auto_assign_enabled']['Default'] ?? '') === '1', 'auto_assign_enabled must default to enabled.');

$tables = [];
$result = $db->query('SHOW TABLES');
while ($row = $result->fetch_row()) {
    $tables[(string) $row[0]] = true;
}
foreach ([$prefix . 'tournament_kiosks', $prefix . 'matches', $prefix . 'tournament_players'] as $table) {
    $assert(isset($tables[$table]), "Required operations table {$table} is missing.");
}

echo "Tournament operations schema OK\n";
