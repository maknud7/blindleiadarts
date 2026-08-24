<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

if ($argc !== 3) {
    fwrite(STDERR, "Usage: php run_php_migration.php <migration-file> <table-prefix>" . PHP_EOL);
    exit(2);
}

$migrationFile = $argv[1];
$prefix = $argv[2];

if (!is_file($migrationFile)) {
    fwrite(STDERR, "PHP migration file not found: {$migrationFile}" . PHP_EOL);
    exit(2);
}

$requiredEnv = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing required environment variable: {$key}");
    }
    return $value;
};

try {
    $mysqli = new mysqli(
        $requiredEnv('DB_HOST'),
        $requiredEnv('DB_USERNAME'),
        $requiredEnv('DB_PASSWORD'),
        $requiredEnv('DB_NAME'),
        (int) $requiredEnv('DB_PORT')
    );
    $mysqli->set_charset('utf8mb4');

    $migration = require $migrationFile;
    if (!is_callable($migration)) {
        throw new RuntimeException("PHP migration must return a callable: {$migrationFile}");
    }

    $migration($mysqli, $prefix);
    $mysqli->close();
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}
