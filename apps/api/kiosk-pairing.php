<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Service\BackendV2ApiAttemptException;
use Blindleia\Dartkiosk\Api\Service\BackendV2ApiClient;
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
    $action = trim((string) ($_GET['action'] ?? ''));

    // Only the kiosk's pre-club pairing-code creation still uses this historical
    // URL. Admin inspection/approval moved to canonical /api/v1 routes.
    if ($action !== 'create') {
        $respond([
            'ok' => false,
            'error' => [
                'code' => 'legacy_pairing_action_removed',
                'message' => 'Denne pairinghandlingen er flyttet til canonical /api/v1.',
            ],
        ], 410);
    }
    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));
    if ($pairingToken === '' || strlen($pairingToken) < 16) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler gyldig device-token.']], 422);
    }
    $payload = $request->jsonBody();
    $deviceName = trim((string) ($payload['device_name'] ?? 'Board Terminal'));
    if ($deviceName === '') $deviceName = 'Board Terminal';
    $deviceName = mb_substr($deviceName, 0, 150);

    if ($config->backendV2EquipmentRoutingMode() === 'node') {
        try {
            $client = new BackendV2ApiClient($config->backendV2BaseUrl(), $config->backendV2InternalToken());
            $result = $client->request(
                'POST',
                '/v1/kiosk-pairing-requests',
                ['device_name' => $deviceName],
                ['x-kiosk-pairing-token' => $pairingToken]
            );
            $status = $result['status'];
            $node = $result['payload'];
            header('X-BD-Backend-V2: equipment');
            if ($status >= 200 && $status < 300 && ($node['ok'] ?? null) === true) {
                unset($node['ok']);
                $respond(['ok' => true, 'data' => $node], $status);
            }
            $error = is_array($node['error'] ?? null) ? $node['error'] : [];
            $respond([
                'ok' => false,
                'error' => [
                    'code' => (string) (($error['code'] ?? '') ?: 'backend_v2_pairing_failed'),
                    'message' => (string) (($error['message'] ?? '') ?: 'Backend-v2 avviste pairingforespørselen.'),
                ],
            ], $status > 0 ? $status : 502);
        } catch (BackendV2ApiAttemptException $error) {
            // Remote outcome may be unknown. Never write the same pairing request
            // locally after a Node attempt.
            header('X-BD-Backend-V2: equipment');
            $respond([
                'ok' => false,
                'error' => [
                    'code' => $error->errorCode,
                    'message' => 'Pairingforespørselen feilet etter Node-dispatch; PHP fallback er deaktivert.',
                ],
            ], 502);
        }
    }

    // PROD remains on this local create path until the equipment PROD cutover.
    $database = new Database($config);
    $db = $database->connection();
    $requestsTable = $database->tablePrefix() . 'kiosk_pairing_requests';
    $fingerprint = hash('sha256', $pairingToken);

    $existing = $db->prepare("SELECT id, request_code, requested_at, expires_at FROM `{$requestsTable}` WHERE pairing_token_fingerprint = ? AND status = 'pending' LIMIT 1");
    $existing->bind_param('s', $fingerprint);
    $existing->execute();
    $row = $existing->get_result()->fetch_assoc() ?: null;
    $existing->close();

    if ($row !== null && strtotime((string) $row['expires_at']) > time()) {
        $respond(['ok' => true, 'data' => ['request' => [
            'request_code' => (string) $row['request_code'],
            'requested_at' => $row['requested_at'],
            'expires_at' => $row['expires_at'],
        ]]]);
    }

    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $requestCode = '';
        for ($i = 0; $i < 6; $i++) $requestCode .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $check = $db->prepare("SELECT id FROM `{$requestsTable}` WHERE request_code = ? LIMIT 1");
        $check->bind_param('s', $requestCode);
        $check->execute();
        $exists = $check->get_result()->fetch_assoc() !== null;
        $check->close();
    } while ($exists);

    $tokenHash = password_hash($pairingToken, PASSWORD_DEFAULT);
    $expiresAt = date('Y-m-d H:i:s', time() + 1800);
    if ($row !== null) {
        $requestId = (int) $row['id'];
        $update = $db->prepare("UPDATE `{$requestsTable}` SET club_id=NULL,request_code=?,pairing_token_hash=?,device_name=?,status='pending',requested_at=NOW(),expires_at=?,approved_kiosk_id=NULL,approved_by_user_account_id=NULL,approved_at=NULL,consumed_at=NULL WHERE id=?");
        $update->bind_param('ssssi', $requestCode, $tokenHash, $deviceName, $expiresAt, $requestId);
        $update->execute();
        $update->close();
    } else {
        $insert = $db->prepare("INSERT INTO `{$requestsTable}` (club_id,request_code,pairing_token_hash,pairing_token_fingerprint,device_name,status,expires_at) VALUES (NULL,?,?,?,?, 'pending',?)");
        $insert->bind_param('sssss', $requestCode, $tokenHash, $fingerprint, $deviceName, $expiresAt);
        $insert->execute();
        $insert->close();
    }

    $respond(['ok' => true, 'data' => ['request' => [
        'request_code' => $requestCode,
        'requested_at' => date('Y-m-d H:i:s'),
        'expires_at' => $expiresAt,
    ]]], 201);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'kiosk_pairing_unavailable',
            'message' => 'Pairing-tjenesten er midlertidig utilgjengelig.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
