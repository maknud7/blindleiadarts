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

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $request = Request::fromGlobals();

    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
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

    $payload = $request->jsonBody();
    $code = $normalizeCode($payload['code'] ?? '');
    $kioskId = (int) ($payload['kiosk_id'] ?? 0);
    if ($code === '' || $kioskId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'replacement_data_required', 'message' => 'Pairingkode og skive må være valgt.']], 422);
    }

    $requestsTable = $prefix . 'kiosk_pairing_requests';
    $kiosksTable = $prefix . 'kiosks';

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

        $kioskStatement = $db->prepare("SELECT id, code, name, board_number, pairing_token_hash, paired_device_name, is_active FROM `{$kiosksTable}` WHERE id = ? AND club_id = ? LIMIT 1 FOR UPDATE");
        $kioskStatement->bind_param('ii', $kioskId, $clubId);
        $kioskStatement->execute();
        $kiosk = $kioskStatement->get_result()->fetch_assoc() ?: null;
        $kioskStatement->close();

        if ($kiosk === null || (int) ($kiosk['is_active'] ?? 0) !== 1) {
            throw new RuntimeException('board_not_found');
        }

        $deviceName = (string) $pairing['device_name'];
        $pairingHash = (string) $pairing['pairing_token_hash'];
        if ($pairingHash === '') {
            throw new RuntimeException('pairing_token_missing');
        }

        // Atomic takeover: the board and its match assignment are untouched.
        // Only the device credential and device metadata are replaced.
        $updateKiosk = $db->prepare("UPDATE `{$kiosksTable}` SET pairing_token_hash = ?, paired_device_name = ?, paired_at = NOW(), last_seen_at = NOW() WHERE id = ? AND club_id = ?");
        $updateKiosk->bind_param('ssii', $pairingHash, $deviceName, $kioskId, $clubId);
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
                'replaced' => trim((string) ($kiosk['pairing_token_hash'] ?? '')) !== '',
                'previous_device_name' => (string) ($kiosk['paired_device_name'] ?? ''),
                'kiosk' => [
                    'id' => (int) $kiosk['id'],
                    'code' => (string) $kiosk['code'],
                    'name' => (string) ($kiosk['name'] ?: ('Skive ' . (int) $kiosk['board_number'])),
                    'board_number' => (int) $kiosk['board_number'],
                    'device_name' => $deviceName,
                ],
            ],
        ]);
    } catch (RuntimeException $error) {
        $db->rollback();
        $map = [
            'pairing_not_found' => [404, 'Pairingkoden finnes ikke.'],
            'pairing_expired' => [409, 'Pairingkoden er utløpt eller allerede brukt. Lag en ny kode på det nye nettbrettet.'],
            'pairing_other_club' => [403, 'Pairingforespørselen tilhører allerede en annen klubb.'],
            'board_not_found' => [404, 'Valgt skive finnes ikke eller er deaktivert.'],
            'pairing_token_missing' => [422, 'Pairingforespørselen mangler gyldig device-token.'],
        ];
        [$status, $message] = $map[$error->getMessage()] ?? [422, 'Kunne ikke bytte nettbrettet.'];
        $respond(['ok' => false, 'error' => ['code' => $error->getMessage(), 'message' => $message]], $status);
    }
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'tablet_replacement_unavailable',
            'message' => 'Bytte av nettbrett er midlertidig utilgjengelig.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
