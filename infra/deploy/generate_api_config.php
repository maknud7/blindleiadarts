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

function env_optional(string $key, ?string $default = null): ?string
{
    $value = getenv($key);
    return $value === false || $value === '' ? $default : $value;
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

$localSeason = env_optional('DARTSATLAS_LOCAL_SEASON_ID');

$config = [
    'app_env' => env_required('APP_ENV'),
    'base_url' => getenv('BASE_URL') ?: '',
    'static_base_url' => getenv('STATIC_BASE_URL') ?: '',
    'screen' => [
        'default_club_slug' => getenv('SCREEN_DEFAULT_CLUB_SLUG') ?: '',
    ],
    'realtime' => [
        'websocket_url' => getenv('REALTIME_WEBSOCKET_URL') ?: '',
        'publish_url' => getenv('REALTIME_PUBLISH_URL') ?: '',
        'publish_secret' => getenv('REALTIME_PUBLISH_SECRET') ?: '',
    ],
    'db' => [
        'host' => env_required('DB_HOST'),
        'port' => (int) env_required('DB_PORT'),
        'database' => env_required('DB_NAME'),
        'username' => env_required('DB_USERNAME'),
        'password' => env_required('DB_PASSWORD'),
        'table_prefix' => env_required('DB_TABLE_PREFIX'),
    ],
    'dartsatlas' => [
        'season_id' => env_optional('DARTSATLAS_SEASON_ID', ''),
        'tournament_id' => env_optional('DARTSATLAS_TOURNAMENT_ID', ''),
        'club_id' => (int) (env_optional('DARTSATLAS_CLUB_ID', '0') ?? '0'),
        'local_season_id' => ($localSeason === null || $localSeason === '') ? null : (int) $localSeason,
        'members_table' => env_optional('DARTSATLAS_MEMBERS_TABLE', 'medlemmer'),
        'poll_interval_seconds' => max(5, (int) (env_optional('DARTSATLAS_POLL_INTERVAL_SECONDS', '8') ?? '8')),
        'user_agent' => env_optional('DARTSATLAS_USER_AGENT', 'BlindleiaDarts/1.0'),
    ],
    'challonge' => [
        'api_base_url' => getenv('CHALLONGE_API_BASE_URL') ?: 'https://api.challonge.com/v2.1',
        'oauth_authorize_url' => getenv('CHALLONGE_OAUTH_AUTHORIZE_URL') ?: 'https://api.challonge.com/oauth/authorize',
        'oauth_token_url' => getenv('CHALLONGE_OAUTH_TOKEN_URL') ?: 'https://api.challonge.com/oauth/token',
        'redirect_uri' => getenv('CHALLONGE_REDIRECT_URI') ?: '',
        'client_id' => getenv('CHALLONGE_CLIENT_ID') ?: '',
        'client_secret' => getenv('CHALLONGE_CLIENT_SECRET') ?: '',
        'default_scopes' => array_values(array_filter(array_map(
            static fn (string $value): string => trim($value),
            explode(',', getenv('CHALLONGE_DEFAULT_SCOPES') ?: 'me,tournaments:read,participants:read,matches:read')
        ))),
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
