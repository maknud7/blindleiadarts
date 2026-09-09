<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ScoliaHardwareSettingsRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
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

$requireAdmin = static function (Request $request, UserAccountRepository $users, int $clubId) use ($respond): array {
    $token = $request->bearerToken();
    if ($token === null) {
        $respond(['ok' => false, 'error' => ['code' => 'authentication_required', 'message' => 'Authentication is required.']], 401);
    }
    $user = $users->findBySessionToken($token);
    if ($user === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Session is invalid or expired.']], 401);
    }
    if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
    if ((string) ($user['role'] ?? '') !== 'club_admin') {
        $respond(['ok' => false, 'error' => ['code' => 'admin_required', 'message' => 'Club administrator access is required.']], 403);
    }
    $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
    if (!in_array($clubId, $clubIds, true)) {
        $respond(['ok' => false, 'error' => ['code' => 'club_access_denied', 'message' => 'You cannot manage this club.']], 403);
    }
    return $user;
};

$toPayload = static function (array $board, bool $canChange): array {
    $serial = trim((string) ($board['serial_number'] ?? ''));
    $physicalScoring = strtolower(trim((string) ($board['scoring_mode'] ?? '')));
    $mode = strtolower(trim((string) ($board['mode'] ?? 'off')));
    $isScolia = $physicalScoring === 'scolia' && $serial !== '';
    $attached = $isScolia && $mode === 'live';
    $released = $isScolia && !$attached;

    return [
        'id' => (int) ($board['id'] ?? 0),
        'physical_kiosk_id' => (int) ($board['physical_kiosk_id'] ?? 0),
        'runtime_kiosk_id' => isset($board['runtime_kiosk_id']) ? (int) $board['runtime_kiosk_id'] : null,
        'board_number' => (int) ($board['board_number'] ?? 0),
        'name' => (string) ($board['name'] ?? ''),
        'serial_number' => $serial,
        'scoring_mode' => $physicalScoring,
        'mode' => $mode,
        'is_scolia' => $isScolia,
        'bridge_attached' => $attached,
        'bridge_released' => $released,
        'direct_scolia_ready' => $released,
        'can_change_bridge' => $canChange,
        'connection_state' => (string) ($board['connection_state'] ?? 'disconnected'),
        'fallback_active' => (int) ($board['fallback_active'] ?? 0),
        'needs_reconciliation' => (int) ($board['needs_reconciliation'] ?? 0),
        // The persistent bridge refreshes active routing periodically. The database
        // ownership switch is immediate; allow a few seconds for the WebSocket close.
        'release_effective_within_seconds' => 12,
        'configuration_scope' => 'production_hardware',
    ];
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $request = Request::fromGlobals();
    if (!in_array($request->method(), ['GET', 'POST'], true)) {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $clubId = (int) ($_GET['club_id'] ?? 0);
    $kioskId = (int) ($_GET['kiosk_id'] ?? 0);
    if ($clubId <= 0 || $kioskId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'board_required', 'message' => 'Klubb og skive må angis.']], 422);
    }

    $users = new UserAccountRepository($database);
    $admin = $requireAdmin($request, $users, $clubId);
    $hardware = new ScoliaHardwareSettingsRepository($database);
    $board = $hardware->getBoardSettings($clubId, $kioskId);
    if ($board === null) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Skiva ble ikke funnet.']], 404);
    }

    $dataPrefix = $database->tablePrefix();
    $hardwarePrefix = $database->hardwareTablePrefix();
    foreach ([$dataPrefix, $hardwarePrefix] as $prefix) {
        if (preg_match('/^[A-Za-z0-9_]+$/', $prefix) !== 1) {
            throw new RuntimeException('Ugyldig tabellprefiks for Scolia-kontroll.');
        }
    }
    $canChange = $dataPrefix === $hardwarePrefix;

    if ($request->method() === 'GET') {
        $respond(['ok' => true, 'data' => ['board' => $toPayload($board, $canChange)] + $hardware->scope()]);
    }

    if (!$canChange) {
        $respond(['ok' => false, 'error' => [
            'code' => 'production_hardware_read_only',
            'message' => 'Frikobling av den fysiske Scolia-skiva gjøres i PROD Utstyr.'
        ]], 403);
    }

    $body = $request->jsonBody();
    if (!array_key_exists('attached', $body) || !is_bool($body['attached'])) {
        $respond(['ok' => false, 'error' => ['code' => 'attached_required', 'message' => 'attached må være true eller false.']], 422);
    }
    $attached = $body['attached'];
    $serial = trim((string) ($board['serial_number'] ?? ''));
    if (strtolower(trim((string) ($board['scoring_mode'] ?? ''))) !== 'scolia' || $serial === '') {
        $respond(['ok' => false, 'error' => ['code' => 'scolia_not_configured', 'message' => 'Denne skiva er ikke konfigurert som en fysisk Scolia-skive.']], 409);
    }

    $physicalId = (int) ($board['physical_kiosk_id'] ?? 0);
    if ($physicalId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'physical_board_required', 'message' => 'Fysisk Scolia-skive kunne ikke bestemmes.']], 409);
    }

    $currentAttached = strtolower(trim((string) ($board['mode'] ?? 'off'))) === 'live';
    if ($currentAttached === $attached) {
        $respond(['ok' => true, 'data' => ['board' => $toPayload($board, true), 'changed' => false] + $hardware->scope()]);
    }

    // If a live Blindleia match is using the board, releasing the hardware first
    // activates the existing manual-fallback/reconciliation safety net. The score is
    // never silently changed by the release operation itself.
    if (!$attached) {
        $runtimeId = (int) ($board['runtime_kiosk_id'] ?? 0);
        if ($runtimeId > 0) {
            $runtime = new ScoliaRepository($database);
            $runtime->markDisconnected($runtimeId, 'Scolia frikoblet fra Blindleia av admin.');
        }
    }

    $db = $database->connection();
    $settingsTable = $hardwarePrefix . 'scolia_board_settings';
    $runtimeTable = $hardwarePrefix . 'scolia_board_runtime';
    $leaseTable = $hardwarePrefix . 'scolia_test_leases';
    $commandsTable = $hardwarePrefix . 'scolia_commands';
    $newMode = $attached ? 'live' : 'off';
    $runtimeState = $attached ? 'disconnected' : 'disabled';
    $userId = (int) ($admin['id'] ?? 0);

    $db->begin_transaction();
    try {
        // Only bridge ownership changes here. The physical board remains a Scolia
        // board and keeps its serial, sponsor, number and all other masterdata.
        $stmt = $db->prepare("UPDATE `{$settingsTable}` SET mode=?,updated_by_user_id=? WHERE kiosk_id=?");
        $stmt->bind_param('sii', $newMode, $userId, $physicalId);
        $stmt->execute();
        if ($stmt->affected_rows < 1 && $currentAttached !== $attached) {
            $stmt->close();
            throw new RuntimeException('Scolia-innstillingen kunne ikke oppdateres.');
        }
        $stmt->close();

        if ($attached) {
            $stmt = $db->prepare(
                "INSERT INTO `{$runtimeTable}` (kiosk_id,connection_state,board_status,board_phase,error_type,connected_at)
                 VALUES (?,'disconnected',NULL,NULL,NULL,NULL)
                 ON DUPLICATE KEY UPDATE connection_state='disconnected',board_status=NULL,board_phase=NULL,error_type=NULL,connected_at=NULL"
            );
            $stmt->bind_param('i', $physicalId);
            $stmt->execute();
            $stmt->close();
        } else {
            $reason = 'Frikoblet fra Blindleia av admin.';
            $stmt = $db->prepare(
                "INSERT INTO `{$runtimeTable}` (kiosk_id,connection_state,board_status,board_phase,error_type,last_disconnect_reason,last_disconnect_at,connected_at)
                 VALUES (?,'disabled',NULL,NULL,NULL,?,NOW(3),NULL)
                 ON DUPLICATE KEY UPDATE connection_state='disabled',board_status=NULL,board_phase=NULL,error_type=NULL,
                    last_disconnect_reason=VALUES(last_disconnect_reason),last_disconnect_at=NOW(3),connected_at=NULL"
            );
            $stmt->bind_param('is', $physicalId, $reason);
            $stmt->execute();
            $stmt->close();

            // A release is authoritative for the physical board. Stale TEST leases
            // must not recapture it when Blindleia is attached again later.
            $stmt = $db->prepare("DELETE FROM `{$leaseTable}` WHERE physical_kiosk_id=?");
            $stmt->bind_param('i', $physicalId);
            $stmt->execute();
            $stmt->close();

            // Never replay old control commands after somebody has used the board
            // directly in Scolia and later reconnects it to Blindleia.
            $expireReason = 'Scolia frikoblet fra Blindleia av admin.';
            $stmt = $db->prepare(
                "UPDATE `{$commandsTable}` SET status='expired',completed_at=NOW(3),last_error=?
                 WHERE kiosk_id=? AND status IN ('queued','delivered','failed')"
            );
            $stmt->bind_param('si', $expireReason, $physicalId);
            $stmt->execute();
            $stmt->close();
        }

        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    $updated = $hardware->getBoardSettings($clubId, $kioskId);
    if ($updated === null) throw new RuntimeException('Skiva forsvant etter Scolia-frikobling.');

    $respond(['ok' => true, 'data' => [
        'board' => $toPayload($updated, true),
        'changed' => true,
        'message' => $attached
            ? 'Scolia kan igjen brukes av Blindleia.'
            : 'Scolia er frikoblet fra Blindleia og kan brukes direkte i Scolia.'
    ] + $hardware->scope()]);
} catch (ValidationException $error) {
    $respond(['ok' => false, 'error' => ['code' => $error->errorCode(), 'message' => $error->getMessage()]], $error->statusCode());
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => [
        'code' => 'scolia_bridge_control_failed',
        'message' => 'Kunne ikke endre Scolia-frikoblingen.',
        'detail' => $error->getMessage(),
    ]], 500);
}
