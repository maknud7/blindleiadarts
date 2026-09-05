<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\RuntimeFailureDiagnostics;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

$config = null;

try {
    $config = Config::load(__DIR__);
    if ($config->appEnv() !== 'test') {
        $respond(['ok' => false, 'error' => ['code' => 'not_found', 'message' => 'Ikke tilgjengelig.']], 404);
    }

    $database = new Database($config);
    $db = $database->connection();
    $testPrefix = $database->tablePrefix();
    $hardwarePrefix = $database->hardwareTablePrefix();
    foreach ([$testPrefix, $hardwarePrefix] as $prefix) {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Ugyldig tabellprefiks.');
        }
    }

    $request = Request::fromGlobals();
    $action = strtolower(trim((string) ($_GET['action'] ?? 'acquire')));
    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));
    if ($pairingToken === '' || strlen($pairingToken) < 16) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler device-token.']], 422);
    }

    $payload = $request->jsonBody();
    $testCode = trim((string) ($payload['test_kiosk_code'] ?? $payload['kiosk_code'] ?? ''));
    if ($testCode === '') {
        $respond(['ok' => false, 'error' => ['code' => 'test_kiosk_required', 'message' => 'Testterminalen mangler skivekode.']], 422);
    }

    $testKiosks = $testPrefix . 'kiosks';
    $testRuntimeBinding = $testPrefix . 'scolia_board_settings';
    $testBoardRuntime = $testPrefix . 'scolia_board_runtime';
    $testBuffers = $testPrefix . 'scolia_visit_buffers';
    $physicalKiosks = $hardwarePrefix . 'kiosks';
    $physicalClubs = $hardwarePrefix . 'clubs';
    $physicalBoardSettings = $hardwarePrefix . 'scolia_board_settings';
    $physicalClubSettings = $hardwarePrefix . 'scolia_club_settings';
    $leaseTable = $hardwarePrefix . 'scolia_test_leases';

    $stmt = $db->prepare(
        "SELECT id,source_kiosk_id,code,name,board_number,scoring_mode,pairing_token_hash
         FROM `{$testKiosks}` WHERE code=? AND is_active=1 LIMIT 1"
    );
    $stmt->bind_param('s', $testCode);
    $stmt->execute();
    $testKiosk = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($testKiosk === null || empty($testKiosk['source_kiosk_id'])) {
        $respond(['ok' => false, 'error' => ['code' => 'test_alias_required', 'message' => 'Velg en fysisk PROD-skive i testmodus først.']], 409);
    }
    $storedPairingHash = (string) ($testKiosk['pairing_token_hash'] ?? '');
    if ($storedPairingHash === '' || !password_verify($pairingToken, $storedPairingHash)) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_pairing', 'message' => 'Testterminalen er ikke paret med denne skiva.']], 403);
    }

    $testKioskId = (int) $testKiosk['id'];
    $physicalKioskId = (int) $testKiosk['source_kiosk_id'];
    $requestedPhysicalId = (int) ($payload['physical_kiosk_id'] ?? $physicalKioskId);
    if ($requestedPhysicalId !== $physicalKioskId) {
        $respond(['ok' => false, 'error' => ['code' => 'physical_board_mismatch', 'message' => 'Testterminalen peker på en annen fysisk skive.']], 409);
    }

    // A lease is the only TEST-owned Scolia state. Serial/token/master settings
    // remain exclusively in the canonical PROD hardware namespace.
    $db->query("DELETE FROM `{$leaseTable}` WHERE expires_at<=NOW(3)");

    if ($action === 'release') {
        $db->begin_transaction();
        try {
            $stmt = $db->prepare("DELETE FROM `{$leaseTable}` WHERE physical_kiosk_id=? AND test_kiosk_id=?");
            $stmt->bind_param('ii', $physicalKioskId, $testKioskId);
            $stmt->execute();
            $stmt->close();

            // Remove the ephemeral TEST runtime binding completely. It is not a
            // second Scolia configuration and must never survive the lease.
            $stmt = $db->prepare("DELETE FROM `{$testRuntimeBinding}` WHERE kiosk_id=?");
            $stmt->bind_param('i', $testKioskId);
            $stmt->execute();
            $stmt->close();

            $stmt = $db->prepare(
                "UPDATE `{$testBoardRuntime}`
                 SET connection_state='disabled',fallback_active=0,needs_reconciliation=0,
                     board_status=NULL,board_phase=NULL,error_type=NULL,last_disconnect_reason=NULL
                 WHERE kiosk_id=?"
            );
            $stmt->bind_param('i', $testKioskId);
            $stmt->execute();
            $stmt->close();

            $stmt = $db->prepare("DELETE FROM `{$testBuffers}` WHERE kiosk_id=?");
            $stmt->bind_param('i', $testKioskId);
            $stmt->execute();
            $stmt->close();

            $stmt = $db->prepare("UPDATE `{$testKiosks}` SET scoring_mode='manual' WHERE id=?");
            $stmt->bind_param('i', $testKioskId);
            $stmt->execute();
            $stmt->close();
            $db->commit();
        } catch (Throwable $error) {
            $db->rollback();
            throw $error;
        }

        $respond(['ok' => true, 'data' => [
            'released' => true,
            'physical_kiosk_id' => $physicalKioskId,
            'test_kiosk_id' => $testKioskId,
            'configuration_scope' => 'production_hardware',
        ]]);
    }

    if ($action === 'heartbeat') {
        $stmt = $db->prepare(
            "UPDATE `{$leaseTable}` SET heartbeat_at=NOW(3),expires_at=DATE_ADD(NOW(3), INTERVAL 3 MINUTE)
             WHERE physical_kiosk_id=? AND test_kiosk_id=? AND expires_at>NOW(3)"
        );
        $stmt->bind_param('ii', $physicalKioskId, $testKioskId);
        $stmt->execute();
        $updated = $stmt->affected_rows;
        $stmt->close();
        if ($updated < 1) {
            $respond(['ok' => false, 'error' => ['code' => 'scolia_test_lease_expired', 'message' => 'Scolia-testleasen har utløpt. Velg skiva på nytt.']], 409);
        }
        $respond(['ok' => true, 'data' => ['active' => true, 'expires_in_seconds' => 180, 'configuration_scope' => 'production_hardware']]);
    }

    if ($action !== 'acquire') {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_action', 'message' => 'Ukjent Scolia test-lease handling.']], 422);
    }

    $stmt = $db->prepare(
        "SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,c.slug AS club_slug,
                s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override,
                cs.enabled AS club_scolia_enabled,cs.access_token,cs.force_connect,cs.forward_messages_to_scolia
         FROM `{$physicalKiosks}` k
         INNER JOIN `{$physicalClubs}` c ON c.id=k.club_id
         LEFT JOIN `{$physicalBoardSettings}` s ON s.kiosk_id=k.id
         LEFT JOIN `{$physicalClubSettings}` cs ON cs.club_id=k.club_id
         WHERE k.id=? AND k.is_active=1 LIMIT 1"
    );
    $stmt->bind_param('i', $physicalKioskId);
    $stmt->execute();
    $physical = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($physical === null) {
        $respond(['ok' => false, 'error' => ['code' => 'physical_board_not_found', 'message' => 'Den fysiske PROD-skiva finnes ikke.']], 404);
    }
    if ((string) ($physical['scoring_mode'] ?? '') !== 'scolia') {
        $respond(['ok' => true, 'data' => [
            'leased' => false,
            'reason' => 'not_scolia',
            'physical_kiosk_id' => $physicalKioskId,
            'test_kiosk_id' => $testKioskId,
            'configuration_scope' => 'production_hardware',
        ]]);
    }

    $serial = strtoupper(trim((string) ($physical['serial_number'] ?? '')));
    $token = trim((string) ($physical['access_token'] ?? ''));
    if ($serial === '' || (string) ($physical['mode'] ?? '') !== 'live' || (int) ($physical['club_scolia_enabled'] ?? 0) !== 1 || $token === '') {
        $respond(['ok' => false, 'error' => [
            'code' => 'scolia_physical_not_ready',
            'message' => 'Den fysiske Scolia-skiva mangler aktivt serienummer, klubbtilkobling eller access token i PROD-innstillingene.'
        ]], 409);
    }

    $stmt = $db->prepare("SELECT test_kiosk_id FROM `{$leaseTable}` WHERE physical_kiosk_id=? AND expires_at>NOW(3) LIMIT 1");
    $stmt->bind_param('i', $physicalKioskId);
    $stmt->execute();
    $activeLease = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($activeLease !== null && (int) $activeLease['test_kiosk_id'] !== $testKioskId) {
        $respond(['ok' => false, 'error' => ['code' => 'scolia_board_already_leased', 'message' => 'Denne Scolia-skiva brukes allerede av en annen testterminal.']], 409);
    }

    $autoFallback = (int) ($physical['auto_fallback_to_manual'] ?? 1) === 1 ? 1 : 0;

    $db->begin_transaction();
    try {
        // Remove any legacy TEST copy of this physical serial. From this point on
        // the TEST row is only an ephemeral mode binding for ScoliaScoringService.
        $stmt = $db->prepare("DELETE FROM `{$testRuntimeBinding}` WHERE serial_number=?");
        $stmt->bind_param('s', $serial);
        $stmt->execute();
        $stmt->close();

        $nullSerial = null;
        $nullOverride = null;
        $stmt = $db->prepare(
            "INSERT INTO `{$testRuntimeBinding}`
             (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
             VALUES (?,?,'live',?,?,?,NULL)
             ON DUPLICATE KEY UPDATE serial_number=NULL,mode='live',
                 auto_fallback_to_manual=VALUES(auto_fallback_to_manual),force_connect_override=NULL,
                 forward_messages_override=NULL,updated_by_user_id=NULL"
        );
        $stmt->bind_param('isiii', $testKioskId, $nullSerial, $autoFallback, $nullOverride, $nullOverride);
        $stmt->execute();
        $stmt->close();

        $stmt = $db->prepare(
            "INSERT INTO `{$testBoardRuntime}` (kiosk_id,connection_state,fallback_active,needs_reconciliation)
             VALUES (?,'disconnected',0,0)
             ON DUPLICATE KEY UPDATE connection_state='disconnected',fallback_active=0,needs_reconciliation=0,
                 board_status=NULL,board_phase=NULL,error_type=NULL,last_disconnect_reason=NULL"
        );
        $stmt->bind_param('i', $testKioskId);
        $stmt->execute();
        $stmt->close();

        $stmt = $db->prepare("UPDATE `{$testKiosks}` SET scoring_mode='scolia' WHERE id=?");
        $stmt->bind_param('i', $testKioskId);
        $stmt->execute();
        $stmt->close();

        $stmt = $db->prepare(
            "INSERT INTO `{$leaseTable}` (physical_kiosk_id,test_kiosk_id,leased_at,heartbeat_at,expires_at)
             VALUES (?,?,NOW(3),NOW(3),DATE_ADD(NOW(3), INTERVAL 3 MINUTE))
             ON DUPLICATE KEY UPDATE test_kiosk_id=VALUES(test_kiosk_id),leased_at=NOW(3),heartbeat_at=NOW(3),
                 expires_at=DATE_ADD(NOW(3), INTERVAL 3 MINUTE)"
        );
        $stmt->bind_param('ii', $physicalKioskId, $testKioskId);
        $stmt->execute();
        $stmt->close();
        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    $respond(['ok' => true, 'data' => [
        'leased' => true,
        'physical_kiosk_id' => $physicalKioskId,
        'test_kiosk_id' => $testKioskId,
        'board_number' => (int) $physical['board_number'],
        'serial_number' => $serial,
        'expires_in_seconds' => 180,
        'configuration_scope' => 'production_hardware',
        'shared_across_environments' => true,
    ]]);
} catch (Throwable $error) {
    RuntimeFailureDiagnostics::log($config, 'kiosk_scolia_test_lease', $error, [
        'method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'),
        'path' => (string) (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: ''),
        'action' => (string) ($_GET['action'] ?? 'acquire'),
    ]);
    $details = RuntimeFailureDiagnostics::details($config, $error);

    $respond(['ok' => false, 'error' => [
        'code' => 'scolia_test_lease_unavailable',
        'message' => 'Scolia-testmodus er midlertidig utilgjengelig.',
        'request_id' => $details['request_id'],
        'detail' => $error->getMessage(),
    ]], 500);
}
