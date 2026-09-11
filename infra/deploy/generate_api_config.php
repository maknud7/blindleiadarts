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

$appEnv = env_required('APP_ENV');
$dataPrefix = env_required('DB_TABLE_PREFIX');
$identityPrefix = env_optional('IDENTITY_TABLE_PREFIX', $dataPrefix) ?? $dataPrefix;
$hardwarePrefix = env_optional('HARDWARE_TABLE_PREFIX', $dataPrefix) ?? $dataPrefix;
$baseUrl = getenv('BASE_URL') ?: '';
$defaultIdentityBaseUrl = $identityPrefix === 'bd_prod_'
    ? 'https://blindleiadart.ingenting.org'
    : $baseUrl;

$isTest = strtolower($appEnv) === 'test';
$isProd = strtolower($appEnv) === 'production' || strtolower($appEnv) === 'prod';
$defaultDbConnectionLimit = $isTest ? '2' : ($isProd ? '6' : '0');
$defaultDbConnectionSlotStart = $isTest ? '6' : '0';
$bridgeSecret = env_required('SCOLIA_BRIDGE_SECRET');

// Scoring was cut over to backend-v2 for the four canonical PROD boards after
// successful TEST and synthetic PROD single-writer canaries. PROD config builds
// must therefore preserve that routing by default; otherwise an ordinary deploy
// would silently revert scoring to the PHP writer. TEST/development remain PHP
// by default and can still opt into explicit canaries through environment vars.
$defaultBackendV2RoutingMode = $isProd ? 'candidate' : 'php';
$defaultBackendV2BaseUrl = $isProd ? 'https://blindleia-backend-v2-readonly.onrender.com' : '';
$defaultBackendV2CanaryKioskIds = $isProd ? '1,2,3,4' : '';
$defaultBackendV2InternalToken = $isProd ? $bridgeSecret : '';

$config = [
    'app_env' => $appEnv,
    'base_url' => $baseUrl,
    'identity_base_url' => env_optional('IDENTITY_BASE_URL', $defaultIdentityBaseUrl) ?? $defaultIdentityBaseUrl,
    'static_base_url' => getenv('STATIC_BASE_URL') ?: '',
    'screen' => [
        'default_club_slug' => getenv('SCREEN_DEFAULT_CLUB_SLUG') ?: '',
    ],
    'realtime' => [
        'websocket_url' => getenv('REALTIME_WEBSOCKET_URL') ?: '',
        'publish_url' => getenv('REALTIME_PUBLISH_URL') ?: '',
        'publish_secret' => getenv('REALTIME_PUBLISH_SECRET') ?: '',
    ],
    'scolia' => [
        'bridge_secret' => $bridgeSecret,
    ],
    'backend_v2' => [
        'scoring_routing_mode' => env_optional('BACKEND_V2_SCORING_ROUTING_MODE', $defaultBackendV2RoutingMode) ?? $defaultBackendV2RoutingMode,
        'base_url' => env_optional('BACKEND_V2_BASE_URL', $defaultBackendV2BaseUrl) ?? $defaultBackendV2BaseUrl,
        'canary_kiosk_ids' => env_optional('BACKEND_V2_CANARY_KIOSK_IDS', $defaultBackendV2CanaryKioskIds) ?? $defaultBackendV2CanaryKioskIds,
        'internal_token' => env_optional('BACKEND_V2_INTERNAL_TOKEN', $defaultBackendV2InternalToken) ?? $defaultBackendV2InternalToken,
    ],
    'db' => [
        'host' => env_required('DB_HOST'),
        'port' => (int) env_required('DB_PORT'),
        'database' => env_required('DB_NAME'),
        'username' => env_required('DB_USERNAME'),
        'password' => env_required('DB_PASSWORD'),
        'table_prefix' => $dataPrefix,
        'identity_table_prefix' => $identityPrefix,
        'hardware_table_prefix' => $hardwarePrefix,
        'max_concurrent_connections' => max(0, (int) (env_optional('DB_MAX_CONCURRENT_CONNECTIONS', $defaultDbConnectionLimit) ?? $defaultDbConnectionLimit)),
        'connection_slot_start' => max(0, (int) (env_optional('DB_CONNECTION_SLOT_START', $defaultDbConnectionSlotStart) ?? $defaultDbConnectionSlotStart)),
        'connection_wait_ms' => max(100, (int) (env_optional('DB_CONNECTION_WAIT_MS', '3000') ?? '3000')),
    ],
    'members_db' => [
        'sqlconnect_path' => env_optional('MEMBERS_SQLCONNECT_PATH', '/home/1/i/ingenting/dart/sqlconnect.php'),
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
