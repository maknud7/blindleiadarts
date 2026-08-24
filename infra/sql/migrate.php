<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function required_env(string $key): string
{
    $value = getenv($key);

    if ($value === false || $value === '') {
        fwrite(STDERR, "Missing required environment variable: {$key}" . PHP_EOL);
        exit(1);
    }

    return $value;
}

function run_multi_query(mysqli $mysqli, string $sql): void
{
    if (!$mysqli->multi_query($sql)) {
        throw new RuntimeException('Failed to start migration query batch.');
    }

    do {
        if ($result = $mysqli->store_result()) {
            $result->free();
        }
    } while ($mysqli->more_results() && $mysqli->next_result());
}

function run_php_migration(string $file, string $prefix, string $worker): void
{
    if (!is_file($worker)) {
        throw new RuntimeException("PHP migration worker not found: {$worker}");
    }

    $command = implode(' ', [
        escapeshellarg(PHP_BINARY),
        escapeshellarg($worker),
        escapeshellarg($file),
        escapeshellarg($prefix),
    ]);

    passthru($command, $exitCode);

    if ($exitCode !== 0) {
        throw new RuntimeException("PHP migration failed with exit code {$exitCode}: {$file}");
    }
}

$root = dirname(__DIR__, 2);
$migrationsDir = $root . DIRECTORY_SEPARATOR . 'infra' . DIRECTORY_SEPARATOR . 'sql' . DIRECTORY_SEPARATOR . 'migrations';
$phpMigrationWorker = $root . DIRECTORY_SEPARATOR . 'infra' . DIRECTORY_SEPARATOR . 'sql' . DIRECTORY_SEPARATOR . 'run_php_migration.php';
$prefix = required_env('DB_TABLE_PREFIX');

if (!is_dir($migrationsDir)) {
    fwrite(STDOUT, "No migrations directory found at {$migrationsDir}" . PHP_EOL);
    exit(0);
}

$sqlFiles = glob($migrationsDir . DIRECTORY_SEPARATOR . '*.sql') ?: [];
$phpFiles = glob($migrationsDir . DIRECTORY_SEPARATOR . '*.php') ?: [];
$files = array_merge($sqlFiles, $phpFiles);
sort($files, SORT_STRING);

$mysqli = new mysqli(
    required_env('DB_HOST'),
    required_env('DB_USERNAME'),
    required_env('DB_PASSWORD'),
    required_env('DB_NAME'),
    (int) required_env('DB_PORT')
);

$mysqli->set_charset('utf8mb4');

$migrationsTable = $prefix . 'schema_migrations';
$mysqli->query(
    "CREATE TABLE IF NOT EXISTS `{$migrationsTable}` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `migration_name` VARCHAR(255) NOT NULL,
        `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uniq_migration_name` (`migration_name`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
);

$applied = [];
$result = $mysqli->query("SELECT migration_name FROM `{$migrationsTable}` ORDER BY migration_name");

while ($row = $result->fetch_assoc()) {
    $applied[$row['migration_name']] = true;
}

$appliedCount = 0;

foreach ($files as $file) {
    $name = basename($file);

    if (isset($applied[$name])) {
        fwrite(STDOUT, "Skipping already applied migration: {$name}" . PHP_EOL);
        continue;
    }

    fwrite(STDOUT, "Applying migration: {$name}" . PHP_EOL);

    if (str_ends_with($file, '.sql')) {
        $sql = file_get_contents($file);

        if ($sql === false) {
            throw new RuntimeException("Failed to read migration file: {$file}");
        }

        $sql = str_replace('{{TABLE_PREFIX}}', $prefix, $sql);
        run_multi_query($mysqli, $sql);
    } elseif (str_ends_with($file, '.php')) {
        run_php_migration($file, $prefix, $phpMigrationWorker);
    } else {
        throw new RuntimeException("Unsupported migration file type: {$file}");
    }

    $statement = $mysqli->prepare(
        "INSERT INTO `{$migrationsTable}` (`migration_name`) VALUES (?)"
    );
    $statement->bind_param('s', $name);
    $statement->execute();
    $statement->close();

    $appliedCount++;
}

fwrite(STDOUT, "Migration run completed. Applied {$appliedCount} migration(s)." . PHP_EOL);
