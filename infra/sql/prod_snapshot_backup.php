<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException("Missing {$key}");
    }
    return trim($value);
};

if ($required('ALLOW_PROD_SNAPSHOT_BACKUP') !== 'yes') {
    throw new RuntimeException('Refusing PROD snapshot without ALLOW_PROD_SNAPSHOT_BACKUP=yes');
}

$sourcePrefix = $required('DB_TABLE_PREFIX');
if ($sourcePrefix !== 'bd_prod_') {
    throw new RuntimeException("Refusing backup for non-production prefix: {$sourcePrefix}");
}

$backupPrefix = $required('BACKUP_TABLE_PREFIX');
if (!preg_match('/^bd_backup_[0-9]{8}_[0-9]{6}_$/', $backupPrefix)) {
    throw new RuntimeException("Unsafe backup prefix: {$backupPrefix}");
}

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$stmt = $db->prepare(
    'SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ? AND TABLE_TYPE="BASE TABLE"
      ORDER BY TABLE_NAME'
);
$like = $sourcePrefix . '%';
$stmt->bind_param('s', $like);
$stmt->execute();
$tables = array_map(
    static fn (array $row): string => (string) $row['TABLE_NAME'],
    $stmt->get_result()->fetch_all(MYSQLI_ASSOC)
);
$stmt->close();
if ($tables === []) {
    throw new RuntimeException('No bd_prod_ tables found to back up.');
}

$existingStmt = $db->prepare(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ?'
);
$backupLike = $backupPrefix . '%';
$existingStmt->bind_param('s', $backupLike);
$existingStmt->execute();
$existing = (int) ($existingStmt->get_result()->fetch_assoc()['c'] ?? 0);
$existingStmt->close();
if ($existing !== 0) {
    throw new RuntimeException("Backup prefix already exists: {$backupPrefix}");
}

$manifestTable = $backupPrefix . 'snapshot_manifest';
$db->query(
    "CREATE TABLE `{$manifestTable}` (
        `source_table` VARCHAR(190) NOT NULL,
        `backup_table` VARCHAR(190) NOT NULL,
        `row_count` BIGINT UNSIGNED NOT NULL,
        `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`source_table`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
);
$manifestInsert = $db->prepare(
    "INSERT INTO `{$manifestTable}` (source_table, backup_table, row_count) VALUES (?,?,?)"
);

$totalRows = 0;
$created = [];
try {
    foreach ($tables as $sourceTable) {
        $suffix = substr($sourceTable, strlen($sourcePrefix));
        if ($suffix === '' || !preg_match('/^[A-Za-z0-9_]+$/', $suffix)) {
            throw new RuntimeException("Unsafe production table name: {$sourceTable}");
        }
        $backupTable = $backupPrefix . $suffix;
        $db->query("CREATE TABLE `{$backupTable}` LIKE `{$sourceTable}`");
        $created[] = $backupTable;
        $db->query("INSERT INTO `{$backupTable}` SELECT * FROM `{$sourceTable}`");
        $count = (int) ($db->query("SELECT COUNT(*) AS c FROM `{$backupTable}`")->fetch_assoc()['c'] ?? 0);
        $sourceCount = (int) ($db->query("SELECT COUNT(*) AS c FROM `{$sourceTable}`")->fetch_assoc()['c'] ?? 0);
        if ($count !== $sourceCount) {
            throw new RuntimeException("Snapshot row-count mismatch for {$sourceTable}: {$sourceCount} vs {$count}");
        }
        $totalRows += $count;
        $manifestInsert->bind_param('ssi', $sourceTable, $backupTable, $count);
        $manifestInsert->execute();
        echo "SNAPSHOT {$sourceTable} -> {$backupTable} rows={$count}" . PHP_EOL;
    }
} catch (Throwable $error) {
    fwrite(STDERR, "PROD snapshot failed. Partial backup tables are intentionally retained for inspection: {$error->getMessage()}" . PHP_EOL);
    throw $error;
} finally {
    $manifestInsert->close();
}

echo 'PROD_SNAPSHOT_BACKUP_OK=yes' . PHP_EOL;
echo 'PROD_SNAPSHOT_PREFIX=' . $backupPrefix . PHP_EOL;
echo 'PROD_SNAPSHOT_TABLES=' . count($tables) . PHP_EOL;
echo 'PROD_SNAPSHOT_ROWS=' . $totalRows . PHP_EOL;
