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

function optional_env(string $key, ?string $default = null): ?string
{
    $value = getenv($key);
    return $value === false || $value === '' ? $default : $value;
}

function table_exists(mysqli $db, string $table): bool
{
    $stmt = $db->prepare(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
    );
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
}

function scalar_count(mysqli $db, string $table, string $where = '1=1'): ?int
{
    if (!table_exists($db, $table)) {
        return null;
    }

    try {
        $result = $db->query("SELECT COUNT(*) AS c FROM `{$table}` WHERE {$where}");
        $count = (int) ($result->fetch_assoc()['c'] ?? 0);
        $result->free();
        return $count;
    } catch (Throwable $error) {
        return null;
    }
}

$prefix = required_env('DB_TABLE_PREFIX');
if ($prefix !== 'bd_prod_') {
    fwrite(STDERR, "Production preflight refuses non-production prefix: {$prefix}" . PHP_EOL);
    exit(1);
}

$hardwarePrefix = optional_env('HARDWARE_TABLE_PREFIX', 'bd_prod_') ?? 'bd_prod_';
if ($hardwarePrefix !== 'bd_prod_') {
    fwrite(STDERR, "Production preflight expects shared physical hardware in bd_prod_: {$hardwarePrefix}" . PHP_EOL);
    exit(1);
}

$db = new mysqli(
    required_env('DB_HOST'),
    required_env('DB_USERNAME'),
    required_env('DB_PASSWORD'),
    required_env('DB_NAME'),
    (int) required_env('DB_PORT')
);
$db->set_charset('utf8mb4');

// Hard safety boundary: every database statement below runs inside a READ ONLY
// transaction. If a future edit accidentally adds DML, MySQL must reject it.
$db->query('START TRANSACTION READ ONLY');

try {
    $root = dirname(__DIR__, 2);
    $migrationDir = $root . '/infra/sql/migrations';
    $migrationFiles = array_merge(
        glob($migrationDir . '/*.sql') ?: [],
        glob($migrationDir . '/*.php') ?: []
    );
    sort($migrationFiles, SORT_STRING);
    $migrationNames = array_map('basename', $migrationFiles);

    $applied = [];
    $migrationTable = $prefix . 'schema_migrations';
    if (table_exists($db, $migrationTable)) {
        $result = $db->query("SELECT migration_name FROM `{$migrationTable}` ORDER BY migration_name");
        while ($row = $result->fetch_assoc()) {
            $applied[(string) $row['migration_name']] = true;
        }
        $result->free();
    }

    $pending = array_values(array_filter(
        $migrationNames,
        static fn (string $name): bool => !isset($applied[$name])
    ));

    // These migrations deliberately no-op outside bd_test_ and are safe to leave
    // pending from a production-readiness perspective.
    $testOnly = [
        '0039_soften_domain_user_foreign_keys.php',
        '0041_add_test_hardware_alias.php',
        '0046_reset_test_tournament_runtime.php',
        '0055_canonicalize_safe_test_player_duplicates.php',
        '0056_reconcile_test_elo_after_identity_cleanup.php',
        '0057_rebuild_test_elo_after_history_import.php',
        '0058_reconcile_test_elo_after_historical_import.php',
        '0059_reconcile_test_elo_for_prod_readiness.php',
    ];

    // PHP migrations can contain arbitrary data rewrites. We therefore require a
    // human review for every pending PHP migration unless it is explicitly test-only.
    $reviewRequired = [];
    foreach ($pending as $name) {
        if (str_ends_with($name, '.php') && !in_array($name, $testOnly, true)) {
            $reviewRequired[] = $name;
        }
    }

    $runtimeCounts = [];
    foreach ([
        'clubs',
        'seasons',
        'players',
        'user_accounts',
        'tournaments',
        'tournament_players',
        'matches',
        'legs',
        'visits',
        'elo_match_events',
        'elo_current_ratings',
        'ranking_snapshots',
    ] as $suffix) {
        $runtimeCounts[$suffix] = scalar_count($db, $prefix . $suffix);
    }

    // Physical boards/screens are canonical shared hardware. TEST is configured with
    // HARDWARE_TABLE_PREFIX=bd_prod_, so these are not duplicate PROD-only devices.
    $sharedHardwareCounts = [
        'physical_boards' => scalar_count($db, $hardwarePrefix . 'kiosks'),
        'screen_devices' => scalar_count($db, $hardwarePrefix . 'screen_devices'),
    ];

    $activeTournaments = scalar_count(
        $db,
        $prefix . 'tournaments',
        "status IN ('ready','in_progress')"
    );
    $activeMatches = scalar_count(
        $db,
        $prefix . 'matches',
        "status IN ('pending','assigned','in_progress')"
    );

    $demoRuntime = null;
    if (table_exists($db, $prefix . 'tournaments')) {
        try {
            $stmt = $db->prepare(
                "SELECT COUNT(*) AS c FROM `{$prefix}tournaments` WHERE slug IN ('blindleia-test-cup','test-123') OR name LIKE '%Test Cup%'"
            );
            $stmt->execute();
            $demoRuntime = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
            $stmt->close();
        } catch (Throwable $error) {
            $demoRuntime = null;
        }
    }

    $effectivePending = array_values(array_filter(
        $pending,
        static fn (string $name): bool => !in_array($name, $testOnly, true)
    ));

    $report = [
        'database_prefix' => $prefix,
        'hardware_table_prefix' => $hardwarePrefix,
        'hardware_scope' => 'shared_test_and_prod',
        'read_only' => true,
        'migrations_total' => count($migrationNames),
        'migrations_applied' => count($applied),
        'migrations_pending' => $pending,
        'migrations_pending_effective_prod' => $effectivePending,
        'migrations_review_required' => $reviewRequired,
        'runtime_counts' => $runtimeCounts,
        'shared_hardware_counts' => $sharedHardwareCounts,
        'active_tournaments' => $activeTournaments,
        'active_matches' => $activeMatches,
        'demo_runtime_tournaments' => $demoRuntime,
        'migration_review_blocked' => $reviewRequired !== [],
    ];

    echo "PROD_PREFLIGHT_READ_ONLY=yes" . PHP_EOL;
    echo "HARDWARE_SCOPE=shared_test_and_prod" . PHP_EOL;
    echo "HARDWARE_TABLE_PREFIX={$hardwarePrefix}" . PHP_EOL;
    echo "MIGRATIONS_TOTAL=" . count($migrationNames) . PHP_EOL;
    echo "MIGRATIONS_APPLIED=" . count($applied) . PHP_EOL;
    echo "MIGRATIONS_PENDING=" . count($pending) . PHP_EOL;
    echo "MIGRATIONS_EFFECTIVE_PROD_PENDING=" . count($effectivePending) . PHP_EOL;
    echo "MIGRATIONS_REVIEW_REQUIRED=" . count($reviewRequired) . PHP_EOL;
    echo "ACTIVE_TOURNAMENTS=" . ($activeTournaments ?? 'unknown') . PHP_EOL;
    echo "ACTIVE_MATCHES=" . ($activeMatches ?? 'unknown') . PHP_EOL;
    echo "DEMO_RUNTIME_TOURNAMENTS=" . ($demoRuntime ?? 'unknown') . PHP_EOL;

    if ($pending !== []) {
        echo "PENDING_MIGRATIONS:" . PHP_EOL;
        foreach ($pending as $name) {
            $flags = [];
            if (in_array($name, $testOnly, true)) {
                $flags[] = 'TEST_ONLY_NOOP_IN_PROD';
            }
            if (in_array($name, $reviewRequired, true)) {
                $flags[] = 'REVIEW_REQUIRED';
            }
            echo ' - ' . $name . ($flags === [] ? '' : ' [' . implode(',', $flags) . ']') . PHP_EOL;
        }
    }

    echo "PROD_RUNTIME_COUNTS:" . PHP_EOL;
    foreach ($runtimeCounts as $name => $count) {
        echo ' - ' . $name . '=' . ($count ?? 'missing/unavailable') . PHP_EOL;
    }

    echo "SHARED_PHYSICAL_HARDWARE_COUNTS:" . PHP_EOL;
    foreach ($sharedHardwareCounts as $name => $count) {
        echo ' - ' . $name . '=' . ($count ?? 'missing/unavailable') . PHP_EOL;
    }

    echo 'PROD_PREFLIGHT_JSON=' . json_encode(
        $report,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    ) . PHP_EOL;

    $db->rollback();

    if ($reviewRequired !== []) {
        fwrite(STDERR, "PROD_PREFLIGHT_GO=no: pending PHP/data migrations require review before production deployment." . PHP_EOL);
        exit(2);
    }

    echo "PROD_PREFLIGHT_GO=yes" . PHP_EOL;
} catch (Throwable $error) {
    try {
        $db->rollback();
    } catch (Throwable $ignored) {
    }
    fwrite(STDERR, 'Production preflight failed: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
