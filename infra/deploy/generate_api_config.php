<?php

declare(strict_types=1);

function env_required(string $key): string
{
    $value = getenv($key);

    if ($value === false || $value === '') {
        fwrite(STDERR, "Missing required environment variable: {$key}" . PHP_EOL);
        exit(1);
    }

    return $value;
}

$output = null;

foreach ($argv as $argument) {
    if (str_starts_with($argument, '--output=')) {
        $output = substr($argument, 9);
    }
}

if ($output === null || $output === '') {
    fwrite(STDERR, "Usage: php infra/deploy/generate_api_config.php --output=/path/to/config.php" . PHP_EOL);
    exit(1);
}

$config = [
    'app_env' => env_required('APP_ENV'),
    'base_url' => getenv('BASE_URL') ?: '',
    'static_base_url' => getenv('STATIC_BASE_URL') ?: '',
    'db' => [
        'host' => env_required('DB_HOST'),
        'port' => (int) env_required('DB_PORT'),
        'database' => env_required('DB_NAME'),
        'username' => env_required('DB_USERNAME'),
        'password' => env_required('DB_PASSWORD'),
        'table_prefix' => env_required('DB_TABLE_PREFIX'),
    ],
    'member_table' => getenv('MEMBER_TABLE') ?: 'medlemmer',
    'dartsatlas' => [
        'base_url' => getenv('DARTSATLAS_BASE_URL') ?: 'https://www.dartsatlas.com',
        'tournament_id' => getenv('DARTSATLAS_TOURNAMENT_ID') ?: '',
        'source_url' => getenv('DARTSATLAS_SOURCE_URL')
            ?: 'https://www.dartsatlas.com/venues/blindleia-dartklubb/tournaments/calendar',
        'season_id' => getenv('DARTSATLAS_SEASON_ID') ?: '',
        'max_tournaments_per_run' => max(
            1,
            (int) (getenv('DARTSATLAS_MAX_TOURNAMENTS_PER_RUN') ?: 3)
        ),
    ],
];

$directory = dirname($output);

if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
    fwrite(STDERR, "Failed to create directory: {$directory}" . PHP_EOL);
    exit(1);
}

$contents = "<?php\n\nreturn " . var_export($config, true) . ";\n";

if (file_put_contents($output, $contents) === false) {
    fwrite(STDERR, "Failed to write config file: {$output}" . PHP_EOL);
    exit(1);
}

fwrite(STDOUT, "Wrote API config to {$output}" . PHP_EOL);
