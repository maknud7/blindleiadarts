<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

try {
    $config = Config::load(__DIR__);
    echo json_encode([
        'ok' => true,
        'data' => [
            'app_env' => $config->appEnv(),
            'runtime_base_url' => $config->baseUrl(),
            'member_onboarding_base_url' => $config->identityBaseUrl(),
        ],
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => [
            'code' => 'onboarding_link_config_unavailable',
            'message' => 'Kunne ikke hente adressene for invitasjoner.',
        ],
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
