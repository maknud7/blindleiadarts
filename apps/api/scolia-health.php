<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();

    $hardwarePrefix = $database->hardwareTablePrefix();
    $dataPrefix = $database->tablePrefix();
    $testPrefix = $config->appEnv() === 'test'
        ? $dataPrefix
        : (preg_match('/prod_$/', $hardwarePrefix) === 1
            ? (string) preg_replace('/prod_$/', 'test_', $hardwarePrefix)
            : 'bd_test_');

    foreach ([$hardwarePrefix, $testPrefix] as $prefix) {
        if (preg_match('/^[A-Za-z0-9_]+$/', $prefix) !== 1) {
            throw new RuntimeException('Invalid Scolia health table prefix.');
        }
    }

    $tableExists = static function (mysqli $connection, string $table): bool {
        $stmt = $connection->prepare(
            'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?'
        );
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 1;
        $stmt->close();
        return $exists;
    };

    $kiosks = $hardwarePrefix . 'kiosks';
    $boardSettings = $hardwarePrefix . 'scolia_board_settings';
    $clubSettings = $hardwarePrefix . 'scolia_club_settings';
    $leases = $hardwarePrefix . 'scolia_test_leases';

    foreach ([$kiosks, $boardSettings, $clubSettings, $leases] as $table) {
        if (!$tableExists($db, $table)) {
            throw new RuntimeException('Scolia health schema is incomplete.');
        }
    }

    $sql = "SELECT k.id AS physical_kiosk_id,k.board_number,k.name,
                   l.test_kiosk_id,l.expires_at
              FROM `{$boardSettings}` s
              INNER JOIN `{$kiosks}` k ON k.id=s.kiosk_id AND k.is_active=1
              INNER JOIN `{$clubSettings}` c ON c.club_id=k.club_id AND c.enabled=1
              LEFT JOIN `{$leases}` l ON l.physical_kiosk_id=k.id AND l.expires_at>NOW(3)
             WHERE s.mode='live'
               AND s.serial_number IS NOT NULL AND s.serial_number<>''
               AND c.access_token IS NOT NULL AND c.access_token<>''
             ORDER BY k.board_number,k.id";
    $configuredBoards = $db->query($sql)->fetch_all(MYSQLI_ASSOC);

    $boards = [];
    $freshHeartbeatCount = 0;
    $connectedCount = 0;
    $activeTestLeases = 0;
    $latestHeartbeatAt = null;
    $latestHeartbeatAge = null;

    foreach ($configuredBoards as $configured) {
        $physicalId = (int) $configured['physical_kiosk_id'];
        $testKioskId = (int) ($configured['test_kiosk_id'] ?? 0);
        $leasedToTest = $testKioskId > 0;
        $runtimePrefix = $leasedToTest ? $testPrefix : $hardwarePrefix;
        $runtimeKioskId = $leasedToTest ? $testKioskId : $physicalId;
        if ($leasedToTest) $activeTestLeases++;

        $runtimeTable = $runtimePrefix . 'scolia_board_runtime';
        $runtime = null;
        if ($tableExists($db, $runtimeTable)) {
            $stmt = $db->prepare(
                "SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                        last_bridge_heartbeat_at,last_event_at,
                        CASE WHEN last_bridge_heartbeat_at IS NULL THEN NULL
                             ELSE TIMESTAMPDIFF(SECOND,last_bridge_heartbeat_at,NOW(3)) END AS heartbeat_age_seconds
                   FROM `{$runtimeTable}` WHERE kiosk_id=? LIMIT 1"
            );
            $stmt->bind_param('i', $runtimeKioskId);
            $stmt->execute();
            $runtime = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
        }

        $heartbeatAge = isset($runtime['heartbeat_age_seconds']) && $runtime['heartbeat_age_seconds'] !== null
            ? max(0, (int) $runtime['heartbeat_age_seconds'])
            : null;
        $heartbeatFresh = $heartbeatAge !== null && $heartbeatAge <= 60;
        $connectionState = (string) ($runtime['connection_state'] ?? 'unknown');
        $connected = $heartbeatFresh && $connectionState === 'connected';

        if ($heartbeatFresh) $freshHeartbeatCount++;
        if ($connected) $connectedCount++;
        if ($heartbeatAge !== null && ($latestHeartbeatAge === null || $heartbeatAge < $latestHeartbeatAge)) {
            $latestHeartbeatAge = $heartbeatAge;
            $latestHeartbeatAt = $runtime['last_bridge_heartbeat_at'] ?? null;
        }

        $boards[] = [
            'board_number' => (int) $configured['board_number'],
            'name' => (string) $configured['name'],
            'route' => $leasedToTest ? 'test' : 'prod',
            'test_lease_active' => $leasedToTest,
            'lease_expires_at' => $leasedToTest ? (string) ($configured['expires_at'] ?? '') : null,
            'connection_state' => $connectionState,
            'board_status' => $runtime['board_status'] ?? null,
            'board_phase' => $runtime['board_phase'] ?? null,
            'heartbeat_fresh' => $heartbeatFresh,
            'heartbeat_age_seconds' => $heartbeatAge,
            'last_bridge_heartbeat_at' => $runtime['last_bridge_heartbeat_at'] ?? null,
            'last_event_at' => $runtime['last_event_at'] ?? null,
            'fallback_active' => (int) ($runtime['fallback_active'] ?? 0) === 1,
            'needs_reconciliation' => (int) ($runtime['needs_reconciliation'] ?? 0) === 1,
        ];
    }

    $secretConfigured = trim($config->scoliaBridgeSecret()) !== '';
    $configuredCount = count($boards);
    $bridgeAlive = $configuredCount === 0 ? null : $freshHeartbeatCount > 0;
    $bridgeStatus = !$secretConfigured
        ? 'misconfigured'
        : ($configuredCount === 0
            ? 'idle'
            : ($bridgeAlive ? 'online' : 'stale'));

    $respond([
        'ok' => true,
        'service' => 'scolia-bridge',
        'generated_at' => gmdate('c'),
        'data' => [
            'configuration_scope' => 'production_hardware',
            'secret_configured' => $secretConfigured,
            'bridge_status' => $bridgeStatus,
            'bridge_alive' => $bridgeAlive,
            'heartbeat_stale_after_seconds' => 60,
            'latest_heartbeat_at' => $latestHeartbeatAt,
            'latest_heartbeat_age_seconds' => $latestHeartbeatAge,
            'configured_boards' => $configuredCount,
            'fresh_heartbeat_boards' => $freshHeartbeatCount,
            'connected_boards' => $connectedCount,
            'active_test_leases' => $activeTestLeases,
            'boards' => $boards,
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'service' => 'scolia-bridge',
        'generated_at' => gmdate('c'),
        'error' => [
            'code' => 'scolia_health_failed',
            'message' => 'Scolia health check failed.',
            'detail' => 'check_failed',
        ],
    ], 503);
}
