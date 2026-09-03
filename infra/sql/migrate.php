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
    fwrite(STDOUT, "No migrations directory found at {$migrationsDir}." . PHP_EOL);
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

// TEST verification, deploy and maintenance workflows can overlap against the same
// hosted database. Serialize migrations per table namespace so two runners can never
// execute or register the same migration concurrently.
$lockName = 'blindleiadarts:migrate:' . $prefix;
$lockStatement = $mysqli->prepare('SELECT GET_LOCK(?, 120) AS acquired');
$lockStatement->bind_param('s', $lockName);
$lockStatement->execute();
$lockRow = $lockStatement->get_result()->fetch_assoc() ?: [];
$lockStatement->close();
if ((int) ($lockRow['acquired'] ?? 0) !== 1) {
    throw new RuntimeException("Could not acquire migration lock for {$prefix}.");
}

try {
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

    // These migrations explicitly do nothing outside bd_test_. Running their PHP
    // worker in PROD still opens an extra database connection, which is unnecessary
    // and can exhaust the hosted database's short connection burst allowance during
    // a long catch-up migration. Record them as applied no-ops instead.
    $testOnlyNoopMigrations = [
        '0046_reset_test_tournament_runtime.php',
        '0055_canonicalize_safe_test_player_duplicates.php',
        '0056_reconcile_test_elo_after_identity_cleanup.php',
        '0057_rebuild_test_elo_after_history_import.php',
        '0058_reconcile_test_elo_after_historical_import.php',
        '0059_reconcile_test_elo_for_prod_readiness.php',
        '0068_cleanup_test_champion_player_labels.php',
        '0073_cleanup_test_legacy_board_materialization.php',
    ];

    $appliedCount = 0;

    foreach ($files as $file) {
        $name = basename($file);

        if (isset($applied[$name])) {
            fwrite(STDOUT, "Skipping already applied migration: {$name}" . PHP_EOL);
            continue;
        }

        if ($prefix !== 'bd_test_' && in_array($name, $testOnlyNoopMigrations, true)) {
            fwrite(STDOUT, "Recording TEST-only no-op migration for {$prefix}: {$name}" . PHP_EOL);
            $statement = $mysqli->prepare(
                "INSERT IGNORE INTO `{$migrationsTable}` (`migration_name`) VALUES (?)"
            );
            $statement->bind_param('s', $name);
            $statement->execute();
            $statement->close();
            $applied[$name] = true;
            $appliedCount++;
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

        // INSERT IGNORE is a second safety net if an older runner that predates the
        // advisory lock happened to register the same migration while this run waited.
        $statement = $mysqli->prepare(
            "INSERT IGNORE INTO `{$migrationsTable}` (`migration_name`) VALUES (?)"
        );
        $statement->bind_param('s', $name);
        $statement->execute();
        $statement->close();

        $applied[$name] = true;
        $appliedCount++;
    }

    fwrite(STDOUT, "Migration run completed. Applied {$appliedCount} migration(s)." . PHP_EOL);
} finally {
    $releaseStatement = $mysqli->prepare('SELECT RELEASE_LOCK(?)');
    $releaseStatement->bind_param('s', $lockName);
    $releaseStatement->execute();
    $releaseStatement->close();
}
