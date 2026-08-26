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
    if ($config->appEnv() !== 'test') {
        $respond(['ok' => false, 'error' => ['code' => 'not_found', 'message' => 'Ikke tilgjengelig.']], 404);
    }

    $database = new Database($config);
    $db = $database->connection();
    $dataPrefix = $database->tablePrefix();
    $hardwarePrefix = $config->hardwareTablePrefix();
    foreach ([$dataPrefix, $hardwarePrefix] as $prefix) {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) throw new RuntimeException('Ugyldig tabellprefiks.');
    }

    $testKiosks = $dataPrefix . 'kiosks';
    $testClubs = $dataPrefix . 'clubs';
    $physicalKiosks = $hardwarePrefix . 'kiosks';
    $physicalClubs = $hardwarePrefix . 'clubs';
    $request = Request::fromGlobals();

    // The original demo seed created BOARD-1..4 in every environment. Those rows
    // are fixtures, not physical hardware, and must never be offered in test mode.
    // Requiring the demo asset path makes this exclusion specific to the old seed
    // and avoids hiding a legitimate board that happens to use a similar code.
    $notLegacyDemoBoard = "NOT (k.code IN ('BOARD-1','BOARD-2','BOARD-3','BOARD-4') AND COALESCE(k.sponsor_logo_url,'') LIKE '/static/sponsors/demo-%')";

    if ($request->method() === 'GET') {
        $result = $db->query(
            "SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,k.sponsor_label,c.name AS club_name,c.slug AS club_slug
             FROM `{$physicalKiosks}` k
             INNER JOIN `{$physicalClubs}` c ON c.id=k.club_id
             WHERE k.is_active=1 AND {$notLegacyDemoBoard}
             ORDER BY c.name,k.board_number,k.id"
        );
        $items = [];
        while ($row = $result->fetch_assoc()) {
            $items[] = [
                'id' => (int) $row['id'],
                'code' => (string) $row['code'],
                'name' => (string) ($row['name'] ?: ('Board ' . (int) $row['board_number'])),
                'board_number' => (int) $row['board_number'],
                'scoring_mode' => (string) $row['scoring_mode'],
                'sponsor_label' => $row['sponsor_label'] !== null ? (string) $row['sponsor_label'] : null,
                'club_name' => (string) $row['club_name'],
                'club_slug' => (string) ($row['club_slug'] ?? ''),
            ];
        }
        $respond(['ok' => true, 'data' => [
            'items' => $items,
            'environment' => 'test',
            'source' => 'physical_hardware_registry',
            'hardware_table_prefix' => $hardwarePrefix,
        ]]);
    }

    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $token = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));
    if ($token === '' || strlen($token) < 16) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler device-token.']], 422);
    }

    $payload = $request->jsonBody();
    $physicalId = (int) ($payload['kiosk_id'] ?? 0);
    if ($physicalId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_required', 'message' => 'Velg et fysisk board.']], 422);
    }

    $stmt = $db->prepare(
        "SELECT k.id,k.code,k.name,k.board_number,k.sponsor_label,k.sponsor_logo_url,k.scoring_mode,c.slug AS club_slug,c.name AS club_name
         FROM `{$physicalKiosks}` k
         INNER JOIN `{$physicalClubs}` c ON c.id=k.club_id
         WHERE k.id=? AND k.is_active=1 AND {$notLegacyDemoBoard} LIMIT 1"
    );
    $stmt->bind_param('i', $physicalId);
    $stmt->execute();
    $physical = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($physical === null) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Det fysiske boardet finnes ikke.']], 404);
    }

    $clubSlug = (string) ($physical['club_slug'] ?? '');
    $stmt = $db->prepare("SELECT id FROM `{$testClubs}` WHERE slug=? LIMIT 1");
    $stmt->bind_param('s', $clubSlug);
    $stmt->execute();
    $testClubId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
    $stmt->close();
    if ($testClubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'test_club_missing', 'message' => 'Klubben finnes ikke i test-runtime.']], 409);
    }

    $deviceName = 'Testmodus · ' . substr(hash('sha256', $token), 0, 12);
    $tokenHash = password_hash($token, PASSWORD_DEFAULT);
    $aliasCode = 'TEST-' . strtoupper(substr(hash('sha256', (string) $physical['code']), 0, 20));
    $name = (string) ($physical['name'] ?: ('Board ' . (int) $physical['board_number']));
    $boardNumber = (int) $physical['board_number'];
    $sponsorLabel = $physical['sponsor_label'] !== null ? (string) $physical['sponsor_label'] : null;
    $sponsorLogo = $physical['sponsor_logo_url'] !== null ? (string) $physical['sponsor_logo_url'] : null;
    // Test runtime deliberately starts manual even when the physical board is Scolia.
    // Real Scolia is one physical service; routing it into test requires an explicit
    // bridge lease and must never happen merely because somebody opened test.
    $runtimeScoring = 'manual';

    $db->begin_transaction();
    try {
        $stmt = $db->prepare("SELECT id FROM `{$testKiosks}` WHERE source_kiosk_id=? LIMIT 1 FOR UPDATE");
        $stmt->bind_param('i', $physicalId);
        $stmt->execute();
        $existingId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();

        if ($existingId > 0) {
            $stmt = $db->prepare(
                "UPDATE `{$testKiosks}` SET club_id=?,code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,
                    pairing_token_hash=?,paired_device_name=?,paired_at=NOW(),last_seen_at=NOW(),is_active=1 WHERE id=?"
            );
            $stmt->bind_param('ississsssi', $testClubId, $aliasCode, $name, $boardNumber, $sponsorLabel, $sponsorLogo, $runtimeScoring, $tokenHash, $deviceName, $existingId);
            $stmt->execute();
            $stmt->close();
            $runtimeId = $existingId;
        } else {
            $stmt = $db->prepare(
                "INSERT INTO `{$testKiosks}`
                 (source_kiosk_id,club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,pairing_token_hash,paired_device_name,paired_at,last_seen_at,is_active)
                 VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),1)"
            );
            $stmt->bind_param('iississsss', $physicalId, $testClubId, $aliasCode, $name, $boardNumber, $sponsorLabel, $sponsorLogo, $runtimeScoring, $tokenHash, $deviceName);
            $stmt->execute();
            $runtimeId = (int) $stmt->insert_id;
            $stmt->close();
        }

        $clear = $db->prepare(
            "UPDATE `{$testKiosks}` SET pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL,last_seen_at=NULL
             WHERE paired_device_name=? AND id<>?"
        );
        $clear->bind_param('si', $deviceName, $runtimeId);
        $clear->execute();
        $clear->close();
        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    $respond(['ok' => true, 'data' => [
        'kiosk' => [
            'id' => $runtimeId,
            'code' => $aliasCode,
            'name' => $name,
            'board_number' => $boardNumber,
            'scoring_mode' => $runtimeScoring,
        ],
        'physical_board' => [
            'id' => $physicalId,
            'code' => (string) $physical['code'],
            'scoring_mode' => (string) $physical['scoring_mode'],
        ],
        'mode' => 'explicit_test_runtime',
    ]]);
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => [
        'code' => 'test_mode_unavailable',
        'message' => 'Testmodus er midlertidig utilgjengelig.',
        'detail' => $error->getMessage(),
    ]], 500);
}
