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
    $prefix = $database->tablePrefix();
    $kiosks = $prefix . 'kiosks';
    $clubs = $prefix . 'clubs';
    $request = Request::fromGlobals();

    if ($request->method() === 'GET') {
        $result = $db->query(
            "SELECT k.id, k.code, k.name, k.board_number, k.scoring_mode, k.is_active, c.name AS club_name
             FROM `{$kiosks}` k
             INNER JOIN `{$clubs}` c ON c.id=k.club_id
             WHERE k.is_active=1
             ORDER BY c.name, k.board_number, k.id"
        );
        $items = [];
        while ($row = $result->fetch_assoc()) {
            $items[] = [
                'id' => (int)$row['id'],
                'code' => (string)$row['code'],
                'name' => (string)($row['name'] ?: ('Board ' . (int)$row['board_number'])),
                'board_number' => (int)$row['board_number'],
                'scoring_mode' => (string)$row['scoring_mode'],
                'club_name' => (string)$row['club_name'],
            ];
        }
        $respond(['ok' => true, 'data' => ['items' => $items, 'environment' => 'test']]);
    }

    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $token = trim((string)($request->header('x-kiosk-pairing-token') ?? ''));
    if ($token === '' || strlen($token) < 16) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler device-token.']], 422);
    }

    $payload = $request->jsonBody();
    $kioskId = (int)($payload['kiosk_id'] ?? 0);
    if ($kioskId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_required', 'message' => 'Velg et board.']], 422);
    }

    $stmt = $db->prepare("SELECT id, code, name, board_number FROM `{$kiosks}` WHERE id=? AND is_active=1 LIMIT 1");
    $stmt->bind_param('i', $kioskId);
    $stmt->execute();
    $kiosk = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($kiosk === null) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Boardet finnes ikke.']], 404);
    }

    $deviceName = 'Testmodus · ' . substr(hash('sha256', $token), 0, 12);
    $tokenHash = password_hash($token, PASSWORD_DEFAULT);

    $db->begin_transaction();
    try {
        $clear = $db->prepare(
            "UPDATE `{$kiosks}`
             SET pairing_token_hash=NULL, paired_device_name=NULL, paired_at=NULL, last_seen_at=NULL
             WHERE paired_device_name=? AND id<>?"
        );
        $clear->bind_param('si', $deviceName, $kioskId);
        $clear->execute();
        $clear->close();

        $assign = $db->prepare(
            "UPDATE `{$kiosks}`
             SET pairing_token_hash=?, paired_device_name=?, paired_at=NOW(), last_seen_at=NOW()
             WHERE id=?"
        );
        $assign->bind_param('ssi', $tokenHash, $deviceName, $kioskId);
        $assign->execute();
        $assign->close();
        $db->commit();
    } catch (Throwable $error) {
        $db->rollback();
        throw $error;
    }

    $respond(['ok' => true, 'data' => ['kiosk' => [
        'id' => (int)$kiosk['id'],
        'code' => (string)$kiosk['code'],
        'name' => (string)($kiosk['name'] ?: ('Board ' . (int)$kiosk['board_number'])),
        'board_number' => (int)$kiosk['board_number'],
    ]]]);
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => ['code' => 'test_mode_unavailable', 'message' => 'Testmodus er midlertidig utilgjengelig.', 'detail' => $error->getMessage()]], 500);
}
