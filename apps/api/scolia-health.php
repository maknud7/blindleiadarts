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
    $tournaments = $hardwarePrefix . 'tournaments';
    $leases = $hardwarePrefix . 'scolia_test_leases';

    foreach ([$kiosks, $boardSettings, $clubSettings, $tournaments, $leases] as $table) {
        if (!$tableExists($db, $table)) {
            throw new RuntimeException('Scolia health schema is incomplete.');
        }
    }

    $activitySql = "SELECT club_id,
                           MAX(CASE
                               WHEN status='in_progress' THEN 1
                               WHEN status IN ('draft','ready')
                                    AND start_at IS NOT NULL
                                    AND start_at BETWEEN DATE_SUB(NOW(3), INTERVAL 8 HOUR)
                                                     AND DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                               THEN 1 ELSE 0 END) AS tournament_active,
                           MIN(CASE
                               WHEN status IN ('draft','ready')
                                    AND start_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                               THEN start_at ELSE NULL END) AS next_start_at
                      FROM `{$tournaments}`
                     WHERE status IN ('draft','ready','in_progress')
                     GROUP BY club_id";
    $activityResult = $db->query($activitySql);
    $clubActivity = [];
    $nextTournamentStartAt = null;
    while ($activity = $activityResult->fetch_assoc()) {
        $clubId = (int) $activity['club_id'];
        $clubActivity[$clubId] = (int) ($activity['tournament_active'] ?? 0) === 1;
        if (!empty($activity['next_start_at'])
            && ($nextTournamentStartAt === null || strcmp((string) $activity['next_start_at'], $nextTournamentStartAt) < 0)) {
            $nextTournamentStartAt = (string) $activity['next_start_at'];
        }
    }

    $sql = "SELECT k.id AS physical_kiosk_id,k.club_id,k.board_number,k.name,
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
    $expectedActiveCount = 0;
    $freshHeartbeatCount = 0;
    $connectedCount = 0;
    $activeTestLeases = 0;
    $activeTournamentBoards = 0;
    $latestHeartbeatAt = null;
    $latestHeartbeatAge = null;

    foreach ($configuredBoards as $configured) {
        $clubId = (int) $configured['club_id'];
        $physicalId = (int) $configured['physical_kiosk_id'];
        $testKioskId = (int) ($configured['test_kiosk_id'] ?? 0);
        $leasedToTest = $testKioskId > 0;
        $tournamentActive = (bool) ($clubActivity[$clubId] ?? false);
        $expectedActive = $leasedToTest || $tournamentActive;
        $activationReason = $leasedToTest ? 'test_lease' : ($tournamentActive ? 'tournament' : 'none');

        if ($leasedToTest) $activeTestLeases++;
        if ($tournamentActive && !$leasedToTest) $activeTournamentBoards++;
        if ($expectedActive) $expectedActiveCount++;

        $runtimePrefix = $leasedToTest ? $testPrefix : $hardwarePrefix;
        $runtimeKioskId = $leasedToTest ? $testKioskId : $physicalId;
        $runtimeTable = $runtimePrefix . 'scolia_board_runtime';
        $runtime = null;

        if ($expectedActive && $tableExists($db, $runtimeTable)) {
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
        $heartbeatFresh = $expectedActive && $heartbeatAge !== null && $heartbeatAge <= 60;
        $connectionState = $expectedActive ? (string) ($runtime['connection_state'] ?? 'unknown') : 'sleeping';
        $connected = $expectedActive && $heartbeatFresh && $connectionState === 'connected';

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
            'expected_active' => $expectedActive,
            'activation_reason' => $activationReason,
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
    $bridgeRequired = $expectedActiveCount > 0;
    $bridgeAlive = $bridgeRequired ? $freshHeartbeatCount > 0 : null;
    $bridgeStatus = !$secretConfigured
        ? 'misconfigured'
        : (!$bridgeRequired
            ? 'sleeping'
            : ($bridgeAlive ? 'online' : 'stale'));

    $respond([
        'ok' => true,
        'service' => 'scolia-bridge',
        'generated_at' => gmdate('c'),
        'data' => [
            'configuration_scope' => 'production_hardware',
            'secret_configured' => $secretConfigured,
            'bridge_status' => $bridgeStatus,
            'bridge_required' => $bridgeRequired,
            'bridge_alive' => $bridgeAlive,
            'heartbeat_stale_after_seconds' => 60,
            'latest_heartbeat_at' => $latestHeartbeatAt,
            'latest_heartbeat_age_seconds' => $latestHeartbeatAge,
            'configured_boards' => $configuredCount,
            'expected_active_boards' => $expectedActiveCount,
            'fresh_heartbeat_boards' => $freshHeartbeatCount,
            'connected_boards' => $connectedCount,
            'active_test_leases' => $activeTestLeases,
            'active_tournament_boards' => $activeTournamentBoards,
            'next_tournament_start_at' => $nextTournamentStartAt,
            'prewarm_minutes' => 30,
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
