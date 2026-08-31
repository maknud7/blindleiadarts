<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
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
    $request = Request::fromGlobals();
    $configuredSecret = $config->scoliaBridgeSecret();
    $providedSecret = trim((string) ($request->header('x-scolia-bridge-secret') ?? ''));
    if ($configuredSecret === '' || $providedSecret === '' || !hash_equals($configuredSecret, $providedSecret)) {
        $respond(['ok' => false, 'error' => ['code' => 'scolia_bridge_unauthorized', 'message' => 'Invalid Scolia bridge secret.']], 401);
    }
    if ($request->method() !== 'GET') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $database = new Database($config);
    $db = $database->connection();
    $prodPrefix = $config->hardwareTablePrefix();
    $testPrefix = $config->appEnv() === 'test'
        ? $database->tablePrefix()
        : (preg_match('/prod_$/', $prodPrefix) === 1 ? preg_replace('/prod_$/', 'test_', $prodPrefix) : 'bd_test_');
    foreach ([$prodPrefix, $testPrefix] as $prefix) {
        if (!is_string($prefix) || !preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Ugyldig tabellprefiks for Scolia bridge router.');
        }
    }

    $prodKiosks = $prodPrefix . 'kiosks';
    $prodBoards = $prodPrefix . 'scolia_board_settings';
    $prodClubs = $prodPrefix . 'scolia_club_settings';
    $prodTournaments = $prodPrefix . 'tournaments';
    $leases = $prodPrefix . 'scolia_test_leases';
    $testKiosks = $testPrefix . 'kiosks';

    // Do not DELETE expired leases on every router poll. Expired rows are ignored
    // by the joins below and are cleaned up by the lease lifecycle itself. This
    // keeps the normal idle bridge path read-only.
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
                               THEN start_at ELSE NULL END) AS next_start_at,
                           MIN(CASE
                               WHEN status IN ('draft','ready')
                                    AND start_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE)
                               THEN TIMESTAMPDIFF(SECOND, NOW(3), DATE_SUB(start_at, INTERVAL 30 MINUTE))
                               ELSE NULL END) AS next_activation_seconds
                    FROM `{$prodTournaments}`
                   WHERE status IN ('draft','ready','in_progress')
                   GROUP BY club_id";
    $activityResult = $db->query($activitySql);
    $clubActivity = [];
    $nextActivationSeconds = null;
    while ($activity = $activityResult->fetch_assoc()) {
        $clubId = (int) $activity['club_id'];
        $clubActivity[$clubId] = [
            'active' => (int) ($activity['tournament_active'] ?? 0) === 1,
            'next_start_at' => $activity['next_start_at'] ?? null,
        ];
        if ($activity['next_activation_seconds'] !== null) {
            $seconds = max(0, (int) $activity['next_activation_seconds']);
            if ($nextActivationSeconds === null || $seconds < $nextActivationSeconds) {
                $nextActivationSeconds = $seconds;
            }
        }
    }

    // Serial, token and board behavior are read exclusively from canonical PROD
    // master data. A TEST lease only changes the runtime destination kiosk.
    $sql = "SELECT k.id AS physical_kiosk_id,k.club_id,k.code,k.name,k.board_number,
                   s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override,
                   c.enabled,c.access_token,c.force_connect,c.forward_messages_to_scolia,c.disconnect_fallback_enabled,
                   l.test_kiosk_id,l.expires_at,
                   tk.id AS active_test_kiosk_id,tk.code AS test_code,tk.name AS test_name,tk.board_number AS test_board_number
            FROM `{$prodBoards}` s
            INNER JOIN `{$prodKiosks}` k ON k.id=s.kiosk_id AND k.is_active=1
            INNER JOIN `{$prodClubs}` c ON c.club_id=k.club_id AND c.enabled=1
            LEFT JOIN `{$leases}` l ON l.physical_kiosk_id=k.id AND l.expires_at>NOW(3)
            LEFT JOIN `{$testKiosks}` tk ON tk.id=l.test_kiosk_id AND tk.source_kiosk_id=k.id AND tk.is_active=1
            WHERE s.mode='live' AND s.serial_number IS NOT NULL AND s.serial_number<>''
              AND c.access_token IS NOT NULL AND c.access_token<>''
            ORDER BY k.club_id,k.board_number,k.id";

    $result = $db->query($sql);
    $boards = [];
    $configuredBoardCount = 0;
    $activeTestLeases = 0;
    $activeTournamentClubs = [];
    while ($row = $result->fetch_assoc()) {
        $configuredBoardCount++;
        $clubId = (int) $row['club_id'];
        $leasedToTest = (int) ($row['active_test_kiosk_id'] ?? 0) > 0;
        $tournamentActive = (bool) ($clubActivity[$clubId]['active'] ?? false);
        if (!$leasedToTest && !$tournamentActive) {
            continue;
        }

        if ($leasedToTest) {
            $activeTestLeases++;
        } else {
            $activeTournamentClubs[$clubId] = true;
        }

        $force = $row['force_connect_override'] === null ? (int) $row['force_connect'] : (int) $row['force_connect_override'];
        $forward = $row['forward_messages_override'] === null
            ? (int) $row['forward_messages_to_scolia'] : (int) $row['forward_messages_override'];

        $boards[] = [
            'connection_key' => (string) $row['serial_number'],
            'kiosk_id' => $leasedToTest ? (int) $row['active_test_kiosk_id'] : (int) $row['physical_kiosk_id'],
            'physical_kiosk_id' => (int) $row['physical_kiosk_id'],
            'club_id' => $clubId,
            'code' => $leasedToTest ? (string) $row['test_code'] : (string) $row['code'],
            'name' => $leasedToTest ? (string) $row['test_name'] : (string) $row['name'],
            'board_number' => $leasedToTest ? (int) $row['test_board_number'] : (int) $row['board_number'],
            'serial_number' => (string) $row['serial_number'],
            'mode' => 'live',
            'auto_fallback_to_manual' => (int) ($row['auto_fallback_to_manual'] ?? 1),
            'access_token' => (string) $row['access_token'],
            'force_connect' => $leasedToTest ? 1 : $force,
            'forward_messages_to_scolia' => $forward,
            'disconnect_fallback_enabled' => (int) ($row['disconnect_fallback_enabled'] ?? 1),
            'target_api_base' => $leasedToTest
                ? 'https://test.blindleiadart.ingenting.org/api/v1'
                : 'https://blindleiadart.ingenting.org/api/v1',
            'environment' => $leasedToTest ? 'test' : 'prod',
            'activation_reason' => $leasedToTest ? 'test_lease' : 'tournament',
            'lease_expires_at' => $leasedToTest ? (string) ($row['expires_at'] ?? '') : null,
            'configuration_scope' => 'production_hardware',
        ];
    }

    $respond(['ok' => true, 'data' => [
        'boards' => $boards,
        'bridge_mode' => $boards === [] ? 'idle' : 'active',
        'idle_poll_seconds' => 300,
        'prewarm_minutes' => 30,
        'late_start_grace_hours' => 8,
        'next_activation_in_seconds' => $nextActivationSeconds,
        'router_environment' => $config->appEnv(),
        'configuration_scope' => 'production_hardware',
        'shared_across_environments' => true,
        'configured_boards' => $configuredBoardCount,
        'active_test_leases' => $activeTestLeases,
        'active_tournament_clubs' => count($activeTournamentClubs),
    ]]);
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => [
        'code' => 'scolia_bridge_router_error',
        'message' => 'Scolia bridge routing configuration could not be loaded.',
        'detail' => $error->getMessage(),
    ]], 500);
}
