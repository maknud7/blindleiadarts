<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit(2);
}

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$get = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException('Missing env: ' . $key);
    }
    return $value;
};

$db = new mysqli(
    $get('DB_HOST'),
    $get('DB_USERNAME'),
    $get('DB_PASSWORD'),
    $get('DB_NAME'),
    (int) $get('DB_PORT')
);
$db->set_charset('utf8mb4');

$prefix = getenv('DB_TABLE_PREFIX') ?: 'bd_test_';
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    throw new RuntimeException('Invalid prefix');
}

$table = $prefix . 'tournament_summaries';

$tableExists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
    );
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$columnExists = static function (mysqli $db, string $table, string $column): bool {
    $stmt = $db->prepare(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
    );
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$indexExists = static function (mysqli $db, string $table, string $index): bool {
    $stmt = $db->prepare(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1'
    );
    $stmt->bind_param('ss', $table, $index);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$columns = [
    'id',
    'tournament_id',
    'title',
    'body_text',
    'status',
    'published_at',
    'created_by_user_account_id',
    'updated_by_user_account_id',
    'created_at',
    'updated_at',
];

$result = [
    'table_exists' => $tableExists($db, $table),
    'columns' => [],
    'unique_tournament_index' => $indexExists($db, $table, 'uniq_tournament_summary_tournament'),
    'status_index' => $indexExists($db, $table, 'idx_tournament_summaries_status'),
];

foreach ($columns as $column) {
    $result['columns'][$column] = $columnExists($db, $table, $column);
}

$result['ready'] = $result['table_exists']
    && !in_array(false, $result['columns'], true)
    && $result['unique_tournament_index']
    && $result['status_index'];

echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($result['ready'] ? 0 : 1);
