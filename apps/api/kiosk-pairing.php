<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
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

$normalizeCode = static function (mixed $value): string {
    return strtoupper(preg_replace('/[^A-Z0-9]/i', '', trim((string) $value)) ?? '');
};

$generateCode = static function () use ($normalizeCode): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $code = '';
    for ($i = 0; $i < 6; $i++) {
        $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $normalizeCode($code);
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $request = Request::fromGlobals();
    $action = trim((string) ($_GET['action'] ?? ''));

    $requestsTable = $prefix . 'kiosk_pairing_requests';
    $kiosksTable = $prefix . 'kiosks';

    if ($action === 'create') {
        if ($request->method() !== 'POST') {
            $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
        }

        $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));
        if ($pairingToken === '' || strlen($pairingToken) < 16) {
            $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler gyldig device-token.']], 422);
        }

        $payload = $request->jsonBody();
        $deviceName = trim((string) ($payload['device_name'] ?? 'Board Terminal'));
        if ($deviceName === '') {
            $deviceName = 'Board Terminal';
        }
        $deviceName = mb_substr($deviceName, 0, 150);
        $fingerprint = hash('sha256', $pairingToken);

        $existing = $db->prepare("SELECT id, request_code, requested_at, expires_at FROM `{$requestsTable}` WHERE pairing_token_fingerprint = ? AND status = 'pending' LIMIT 1");
        $existing->bind_param('s', $fingerprint);
        $existing->execute();
        $row = $existing->get_result()->fetch_assoc() ?: null;
        $existing->close();

        if ($row !== null && strtotime((string) $row['expires_at']) > time()) {
            $respond([
                'ok' => true,
                'data' => [
                    'request' => [
                        'request_code' => (string) $row['request_code'],
                        'requested_at' => $row['requested_at'],
                        'expires_at' => $row['expires_at'],
                    ],
                ],
            ]);
        }

        $tokenHash = password_hash($pairingToken, PASSWORD_DEFAULT);
        $expiresAt = date('Y-m-d H:i:s', time() + 1800);

        do {
            $requestCode = $generateCode();
            $check = $db->prepare("SELECT id FROM `{$requestsTable}` WHERE request_code = ? LIMIT 1");
            $check->bind_param('s', $requestCode);
            $check->execute();
            $exists = $check->get_result()->fetch_assoc() !== null;
            $check->close();
        } while ($exists);

        if ($row !== null) {
            $requestId = (int) $row['id'];
            $update = $db->prepare("UPDATE `{$requestsTable}` SET club_id = NULL, request_code = ?, pairing_token_hash = ?, device_name = ?, requested_at = NOW(), expires_at = ?, approved_kiosk_id = NULL, approved_by_user_account_id = NULL, approved_at = NULL, consumed_at = NULL WHERE id = ?");
            $update->bind_param('ssssi', $requestCode, $tokenHash, $deviceName, $expiresAt, $requestId);
            $update->execute();
            $update->close();
        } else {
            $insert = $db->prepare("INSERT INTO `{$requestsTable}` (club_id, request_code, pairing_token_hash, pairing_token_fingerprint, device_name, status, expires_at) VALUES (NULL, ?, ?, ?, ?, 'pending', ?)");
            $insert->bind_param('sssss', $requestCode, $tokenHash, $fingerprint, $deviceName, $expiresAt);
            $insert->execute();
            $insert->close();
        }

        $respond([
            'ok' => true,
            'data' => [
                'request' => [
                    'request_code' => $requestCode,
                    'requested_at' => date('Y-m-d H:i:s'),
                    'expires_at' => $expiresAt,
                ],
            ],
        ], 201);
    }

    $users = new UserAccountRepository($database);
    $token = $request->bearerToken();
    if ($token === null) {
        $respond(['ok' => false, 'error' => ['code' => 'missing_bearer_token', 'message' => 'Innlogging kreves.']], 401);
    }

    $user = $users->findBySessionToken($token);
    if ($user === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen er ugyldig eller utløpt.']], 401);
    }

    $role = (string) ($user['role'] ?? 'player');
    if (!in_array($role, ['club_admin', 'super_admin'], true)) {
        $respond(['ok' => false, 'error' => ['code' => 'admin_required', 'message' => 'Administratortilgang kreves.']], 403);
    }

    $clubId = filter_input(INPUT_GET, 'club_id', FILTER_VALIDATE_INT);
    $clubId = is_int($clubId) && $clubId > 0 ? $clubId : 0;
    if ($clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'club_id mangler.']], 422);
    }

    if ($role === 'club_admin' && (int) ($user['player_club_id'] ?? 0) !== $clubId) {
        $respond(['ok' => false, 'error' => ['code' => 'club_scope_denied', 'message' => 'Du administrerer ikke denne klubben.']], 403);
    }

    if ($action === 'admin-info') {
        if ($request->method() !== 'GET') {
            $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
        }

        $code = $normalizeCode($_GET['code'] ?? '');
        if ($code === '') {
            $respond(['ok' => false, 'error' => ['code' => 'code_required', 'message' => 'Pairingkode mangler.']], 422);
        }

        $statement = $db->prepare("SELECT id, club_id, request_code, device_name, status, requested_at, expires_at, approved_kiosk_id FROM `{$requestsTable}` WHERE request_code = ? LIMIT 1");
        $statement->bind_param('s', $code);
        $statement->execute();
        $pairing = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($pairing === null) {
            $respond(['ok' => false, 'error' => ['code' => 'pairing_not_found', 'message' => 'Pairingkoden finnes ikke.']], 404);
        }

        $expired = strtotime((string) $pairing['expires_at']) <= time();
        $assignedClubId = $pairing['club_id'] !== null ? (int) $pairing['club_id'] : null;
        $claimable = (string) $pairing['status'] === 'pending' && !$expired && ($assignedClubId === null || $assignedClubId === $clubId);

        $respond([
            'ok' => true,
            'data' => [
                'request' => [
                    'request_code' => (string) $pairing['request_code'],
                    'device_name' => (string) $pairing['device_name'],
                    'status' => $expired && (string) $pairing['status'] === 'pending' ? 'expired' : (string) $pairing['status'],
                    'requested_at' => $pairing['requested_at'],
                    'expires_at' => $pairing['expires_at'],
                    'claimable' => $claimable,
                ],
            ],
        ]);
    }

    if ($action === 'claim') {
        if ($request->method() !== 'POST') {
            $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
        }

        $payload = $request->jsonBody();
        $code = $normalizeCode($payload['code'] ?? '');
        $kioskId = (int) ($payload['kiosk_id'] ?? 0);
        if ($code === '' || $kioskId <= 0) {
            $respond(['ok' => false, 'error' => ['code' => 'claim_data_required', 'message' => 'Pairingkode og board må velges.']], 422);
        }

        $db->begin_transaction();
        try {
            $pairingStatement = $db->prepare("SELECT id, club_id, pairing_token_hash, device_name, status, expires_at FROM `{$requestsTable}` WHERE request_code = ? LIMIT 1 FOR UPDATE");
            $pairingStatement->bind_param('s', $code);
            $pairingStatement->execute();
            $pairing = $pairingStatement->get_result()->fetch_assoc() ?: null;
            $pairingStatement->close();

            if ($pairing === null) {
                throw new RuntimeException('pairing_not_found');
            }
            if ((string) $pairing['status'] !== 'pending' || strtotime((string) $pairing['expires_at']) <= time()) {
                throw new RuntimeException('pairing_expired');
            }
            if ($pairing['club_id'] !== null && (int) $pairing['club_id'] !== $clubId) {
                throw new RuntimeException('pairing_other_club');
            }

            $kioskStatement = $db->prepare("SELECT id, code, name, board_number, pairing_token_hash, is_active FROM `{$kiosksTable}` WHERE id = ? AND club_id = ? LIMIT 1 FOR UPDATE");
            $kioskStatement->bind_param('ii', $kioskId, $clubId);
            $kioskStatement->execute();
            $kiosk = $kioskStatement->get_result()->fetch_assoc() ?: null;
            $kioskStatement->close();

            if ($kiosk === null || (int) ($kiosk['is_active'] ?? 0) !== 1) {
                throw new RuntimeException('board_not_found');
            }
            if (trim((string) ($kiosk['pairing_token_hash'] ?? '')) !== '') {
                throw new RuntimeException('board_already_paired');
            }

            $deviceName = (string) $pairing['device_name'];
            $pairingHash = (string) $pairing['pairing_token_hash'];
            $updateKiosk = $db->prepare("UPDATE `{$kiosksTable}` SET pairing_token_hash = ?, paired_device_name = ?, paired_at = NOW(), last_seen_at = NOW() WHERE id = ?");
            $updateKiosk->bind_param('ssi', $pairingHash, $deviceName, $kioskId);
            $updateKiosk->execute();
            $updateKiosk->close();

            $userId = (int) $user['id'];
            $pairingId = (int) $pairing['id'];
            $approve = $db->prepare("UPDATE `{$requestsTable}` SET club_id = ?, status = 'approved', approved_kiosk_id = ?, approved_by_user_account_id = ?, approved_at = NOW(), consumed_at = NOW() WHERE id = ?");
            $approve->bind_param('iiii', $clubId, $kioskId, $userId, $pairingId);
            $approve->execute();
            $approve->close();

            $db->commit();

            $respond([
                'ok' => true,
                'data' => [
                    'kiosk' => [
                        'id' => (int) $kiosk['id'],
                        'code' => (string) $kiosk['code'],
                        'name' => (string) ($kiosk['name'] ?: ('Board ' . (int) $kiosk['board_number'])),
                        'board_number' => (int) $kiosk['board_number'],
                        'device_name' => $deviceName,
                    ],
                ],
            ]);
        } catch (RuntimeException $error) {
            $db->rollback();
            $map = [
                'pairing_not_found' => [404, 'Pairingkoden finnes ikke.'],
                'pairing_expired' => [409, 'Pairingkoden er utløpt eller allerede brukt. Lag en ny kode på nettbrettet.'],
                'pairing_other_club' => [403, 'Pairingforespørselen tilhører allerede en annen klubb.'],
                'board_not_found' => [404, 'Valgt board finnes ikke i denne klubben.'],
                'board_already_paired' => [409, 'Dette boardet er allerede paret. Nullstill pairing på boardet først.'],
            ];
            [$status, $message] = $map[$error->getMessage()] ?? [422, 'Kunne ikke koble terminalen.'];
            $respond(['ok' => false, 'error' => ['code' => $error->getMessage(), 'message' => $message]], $status);
        }
    }

    $respond(['ok' => false, 'error' => ['code' => 'unknown_action', 'message' => 'Ukjent handling.']], 404);
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
