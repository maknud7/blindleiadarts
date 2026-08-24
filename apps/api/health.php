<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$payload = [
    'ok' => false,
    'service' => 'blindleiadarts',
    'checks' => [],
];
$status = 503;

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $connection = $database->connection();
    $connection->query('SELECT 1');

    $prefix = $database->tablePrefix();
    $coreTable = $prefix . 'clubs';
    $tableStatement = $connection->prepare(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1'
    );
    $tableStatement->bind_param('s', $coreTable);
    $tableStatement->execute();
    $coreReady = $tableStatement->get_result()->fetch_assoc() !== null;
    $tableStatement->close();

    $membership = new MembershipDatabase($config, $database, 'medlemmer');
    $memberConnection = $membership->connection();
    $memberSource = $membership->source();
    $memberReady = $memberConnection instanceof mysqli;

    $release = null;
    $releasePath = dirname(__DIR__) . '/release.json';
    if (is_file($releasePath)) {
        $decoded = json_decode((string) file_get_contents($releasePath), true);
        if (is_array($decoded)) {
            $release = [
                'environment' => isset($decoded['environment']) ? (string) $decoded['environment'] : null,
                'sha' => isset($decoded['sha']) ? (string) $decoded['sha'] : null,
            ];
        }
    }

    $payload = [
        'ok' => $coreReady && $memberReady,
        'service' => 'blindleiadarts',
        'app_env' => $config->appEnv(),
        'release' => $release,
        'checks' => [
            'database' => true,
            'core_schema' => $coreReady,
            'member_registry' => $memberReady,
        ],
        'member_registry' => [
            'source' => $memberSource,
        ],
    ];
    $status = $payload['ok'] ? 200 : 503;
} catch (Throwable) {
    $payload['checks']['database'] = false;
    $payload['error'] = [
        'code' => 'internal_health_failed',
        'message' => 'BlindleiaDarts internal health check failed.',
    ];
}

http_response_code($status);
echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
