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
        $items = [];
        $seenBoards = [];

        $result = $db->query(
            "SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,k.sponsor_label,c.name AS club_name,c.slug AS club_slug
             FROM `{$physicalKiosks}` k
             INNER JOIN `{$physicalClubs}` c ON c.id=k.club_id
             WHERE k.is_active=1 AND {$notLegacyDemoBoard}
             ORDER BY c.name,k.board_number,k.id"
        );
        while ($row = $result->fetch_assoc()) {
            $key = strtolower((string) ($row['club_slug'] ?? '')) . ':' . (int) $row['board_number'];
            $seenBoards[$key] = true;
            $items[] = [
                'id' => (int) $row['id'],
                'code' => (string) $row['code'],
                'name' => (string) ($row['name'] ?: ('Board ' . (int) $row['board_number'])),
                'board_number' => (int) $row['board_number'],
                'scoring_mode' => (string) $row['scoring_mode'],
                'sponsor_label' => $row['sponsor_label'] !== null ? (string) $row['sponsor_label'] : null,
                'club_name' => (string) $row['club_name'],
                'club_slug' => (string) ($row['club_slug'] ?? ''),
                'source' => 'physical',
            ];
        }

        // Boards created deliberately in the test admin live in the isolated test
        // namespace. They are valid test targets too. Runtime aliases created from a
        // production board have source_kiosk_id set and are intentionally excluded.
        $result = $db->query(
            "SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,k.sponsor_label,c.name AS club_name,c.slug AS club_slug
             FROM `{$testKiosks}` k
             INNER JOIN `{$testClubs}` c ON c.id=k.club_id
             WHERE k.is_active=1 AND k.source_kiosk_id IS NULL AND {$notLegacyDemoBoard}
             ORDER BY c.name,k.board_number,k.id"
        );
        while ($row = $result->fetch_assoc()) {
            $key = strtolower((string) ($row['club_slug'] ?? '')) . ':' . (int) $row['board_number'];
            if (isset($seenBoards[$key])) {
                continue;
            }
            $seenBoards[$key] = true;
            $items[] = [
                'id' => (int) $row['id'],
                'code' => (string) $row['code'],
                'name' => (string) ($row['name'] ?: ('Board ' . (int) $row['board_number'])),
                'board_number' => (int) $row['board_number'],
                'scoring_mode' => (string) $row['scoring_mode'],
                'sponsor_label' => $row['sponsor_label'] !== null ? (string) $row['sponsor_label'] : null,
                'club_name' => (string) $row['club_name'],
                'club_slug' => (string) ($row['club_slug'] ?? ''),
                'source' => 'test',
            ];
        }

        usort($items, static function (array $a, array $b): int {
            return [strtolower((string) $a['club_name']), (int) $a['board_number'], (int) $a['id']]
                <=> [strtolower((string) $b['club_name']), (int) $b['board_number'], (int) $b['id']];
        });

        $respond(['ok' => true, 'data' => [
            'items' => $items,
            'environment' => 'test',
            'source' => 'physical_and_test_board_registry',
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
    $selectedId = (int) ($payload['kiosk_id'] ?? 0);
    $source = strtolower(trim((string) ($payload['source'] ?? 'physical')));
    if ($selectedId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_required', 'message' => 'Velg et board.']], 422);
    }

    $deviceName = 'Testmodus · ' . substr(hash('sha256', $token), 0, 12);
    $tokenHash = password_hash($token, PASSWORD_DEFAULT);

    if ($source === 'test') {
        $stmt = $db->prepare(
            "SELECT k.id,k.code,k.name,k.board_number,k.sponsor_label,k.sponsor_logo_url,k.scoring_mode,c.slug AS club_slug,c.name AS club_name
             FROM `{$testKiosks}` k
             INNER JOIN `{$testClubs}` c ON c.id=k.club_id
             WHERE k.id=? AND k.is_active=1 AND k.source_kiosk_id IS NULL AND {$notLegacyDemoBoard} LIMIT 1"
        );
        $stmt->bind_param('i', $selectedId);
        $stmt->execute();
        $board = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($board === null) {
            $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Testboardet finnes ikke.']], 404);
        }

        $db->begin_transaction();
        try {
            $clear = $db->prepare(
                "UPDATE `{$testKiosks}` SET pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL,last_seen_at=NULL
                 WHERE paired_device_name=? AND id<>?"
            );
            $clear->bind_param('si', $deviceName, $selectedId);
            $clear->execute();
            $clear->close();

            $pair = $db->prepare(
                "UPDATE `{$testKiosks}` SET pairing_token_hash=?,paired_device_name=?,paired_at=NOW(),last_seen_at=NOW()
                 WHERE id=?"
            );
            $pair->bind_param('ssi', $tokenHash, $deviceName, $selectedId);
            $pair->execute();
            $pair->close();
            $db->commit();
        } catch (Throwable $error) {
            $db->rollback();
            throw $error;
        }

        $respond(['ok' => true, 'data' => [
            'kiosk' => [
                'id' => $selectedId,
                'code' => (string) $board['code'],
                'name' => (string) $board['name'],
                'board_number' => (int) $board['board_number'],
                'scoring_mode' => (string) $board['scoring_mode'],
            ],
            'source_board' => [
                'id' => $selectedId,
                'source' => 'test',
            ],
            'mode' => 'direct_test_board',
        ]]);
    }

    if ($source !== 'physical') {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_board_source', 'message' => 'Ugyldig boardkilde.']], 422);
    }

    $physicalId = $selectedId;
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
        // A physical board can already have an explicit TEST alias. Older TEST data can
        // also contain a local row using the same club/board number from before hardware
        // became canonical in PROD. Reuse that row instead of colliding with the unique
        // (club_id, board_number) key. This preserves historical match foreign keys while
        // converging the row onto the canonical physical source.
        $sourceRuntimeId = 0;
        $stmt = $db->prepare("SELECT id FROM `{$testKiosks}` WHERE source_kiosk_id=? LIMIT 1 FOR UPDATE");
        $stmt->bind_param('i', $physicalId);
        $stmt->execute();
        $sourceRuntimeId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();

        $boardRuntimeId = 0;
        $stmt = $db->prepare("SELECT id FROM `{$testKiosks}` WHERE club_id=? AND board_number=? LIMIT 1 FOR UPDATE");
        $stmt->bind_param('ii', $testClubId, $boardNumber);
        $stmt->execute();
        $boardRuntimeId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();

        if ($sourceRuntimeId > 0 && $boardRuntimeId > 0 && $sourceRuntimeId !== $boardRuntimeId) {
            // Keep the canonical source alias on the real board number. The conflicting
            // legacy TEST row may still be referenced by old matches, so retain it but
            // move it out of the active board registry instead of deleting it.
            $maxResult = $db->query("SELECT COALESCE(MAX(board_number),0) AS max_board FROM `{$testKiosks}` WHERE club_id=" . (int) $testClubId);
            $legacyBoardNumber = max($boardNumber + 1, (int) (($maxResult->fetch_assoc()['max_board'] ?? 0) + 1));
            $maxResult->free();
            $legacyName = 'Historisk TEST-skive';
            $stmt = $db->prepare(
                "UPDATE `{$testKiosks}` SET board_number=?,name=?,is_active=0,pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL,last_seen_at=NULL WHERE id=?"
            );
            $stmt->bind_param('isi', $legacyBoardNumber, $legacyName, $boardRuntimeId);
            $stmt->execute();
            $stmt->close();
            $runtimeId = $sourceRuntimeId;
        } elseif ($sourceRuntimeId > 0) {
            $runtimeId = $sourceRuntimeId;
        } elseif ($boardRuntimeId > 0) {
            $runtimeId = $boardRuntimeId;
        } else {
            $runtimeId = 0;
        }

        if ($runtimeId > 0) {
            $stmt = $db->prepare(
                "UPDATE `{$testKiosks}` SET source_kiosk_id=?,club_id=?,code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,
                    pairing_token_hash=?,paired_device_name=?,paired_at=NOW(),last_seen_at=NOW(),is_active=1 WHERE id=?"
            );
            $stmt->bind_param('iississsssi', $physicalId, $testClubId, $aliasCode, $name, $boardNumber, $sponsorLabel, $sponsorLogo, $runtimeScoring, $tokenHash, $deviceName, $runtimeId);
            $stmt->execute();
            $stmt->close();
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
        'source_board' => [
            'id' => $physicalId,
            'source' => 'physical',
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
