<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ClubRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;

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

$nullable = static function (mixed $value, int $maxLength): ?string {
    $value = trim((string) $value);
    return $value === '' ? null : mb_substr($value, 0, $maxLength);
};

$validScoliaSerial = static function (string $value): bool {
    return preg_match('/^[A-Za-z0-9._:-]{3,120}$/', $value) === 1;
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
    $sessionToken = $request->bearerToken();
    if ($sessionToken === null) {
        $respond(['ok' => false, 'error' => ['code' => 'missing_bearer_token', 'message' => 'Innlogging kreves.']], 401);
    }

    $user = $users->findBySessionToken($sessionToken);
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
    $pairingCode = $normalizeCode($payload['code'] ?? '');
    $board = is_array($payload['board'] ?? null) ? $payload['board'] : [];

    if ($pairingCode === '') {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_code_required', 'message' => 'Pairingkode mangler.']], 422);
    }

    $requestsTable = $prefix . 'kiosk_pairing_requests';
    $kiosksTable = $prefix . 'kiosks';
    $clubs = new ClubRepository($database);
    $scolia = new ScoliaRepository($database);

    $db->begin_transaction();
    try {
        $pairingStatement = $db->prepare("SELECT id, club_id, pairing_token_hash, device_name, status, expires_at FROM `{$requestsTable}` WHERE request_code = ? LIMIT 1 FOR UPDATE");
        $pairingStatement->bind_param('s', $pairingCode);
        $pairingStatement->execute();
        $pairing = $pairingStatement->get_result()->fetch_assoc() ?: null;
        $pairingStatement->close();

        if ($pairing === null) throw new RuntimeException('pairing_not_found');
        if ((string) $pairing['status'] !== 'pending' || strtotime((string) $pairing['expires_at']) <= time()) throw new RuntimeException('pairing_expired');
        if ($pairing['club_id'] !== null && (int) $pairing['club_id'] !== $clubId) throw new RuntimeException('pairing_other_club');

        $boardNumber = (int) ($board['board_number'] ?? 0);
        if ($boardNumber <= 0) {
            $next = $db->prepare("SELECT COALESCE(MAX(board_number), 0) + 1 AS next_board FROM `{$kiosksTable}` WHERE club_id = ?");
            $next->bind_param('i', $clubId);
            $next->execute();
            $nextRow = $next->get_result()->fetch_assoc() ?: ['next_board' => 1];
            $next->close();
            $boardNumber = max(1, (int) $nextRow['next_board']);
        }

        $duplicate = $db->prepare("SELECT id FROM `{$kiosksTable}` WHERE club_id = ? AND board_number = ? LIMIT 1 FOR UPDATE");
        $duplicate->bind_param('ii', $clubId, $boardNumber);
        $duplicate->execute();
        $boardExists = $duplicate->get_result()->fetch_assoc() !== null;
        $duplicate->close();
        if ($boardExists) throw new RuntimeException('board_number_exists');

        $name = trim((string) ($board['name'] ?? ''));
        if ($name === '') $name = 'Board ' . $boardNumber;
        $name = mb_substr($name, 0, 120);
        $sponsorLabel = $nullable($board['sponsor_label'] ?? null, 150);
        $sponsorLogoUrl = $nullable($board['sponsor_logo_url'] ?? null, 255);
        $scoringMode = (string) ($board['scoring_mode'] ?? 'manual');
        if (!in_array($scoringMode, ['manual', 'scolia'], true)) $scoringMode = 'manual';
        $scoliaSerial = trim((string) ($board['scolia_serial_number'] ?? ''));
        if ($scoringMode === 'scolia') {
            if (!$validScoliaSerial($scoliaSerial)) throw new RuntimeException('scolia_serial_required');
            if ($scolia->findBoardBySerial($scoliaSerial) !== null) throw new RuntimeException('scolia_serial_in_use');
        }

        $created = $clubs->createKiosk($clubId, [
            'board_number' => $boardNumber,
            'name' => $name,
            'sponsor_label' => $sponsorLabel,
            'sponsor_logo_url' => $sponsorLogoUrl,
            'scoring_mode' => $scoringMode,
        ]);
        $kioskId = (int) ($created['id'] ?? 0);
        if ($kioskId <= 0) throw new RuntimeException('board_create_failed');

        $userId = (int) $user['id'];
        if ($scoringMode === 'scolia') {
            $scolia->updateBoardSettings($clubId, $kioskId, [
                'serial_number' => $scoliaSerial,
                'mode' => 'live',
                'auto_fallback_to_manual' => true,
            ], $userId);
        }

        $deviceName = (string) $pairing['device_name'];
        $pairingHash = (string) $pairing['pairing_token_hash'];
        $pairKiosk = $db->prepare("UPDATE `{$kiosksTable}` SET pairing_token_hash = ?, paired_device_name = ?, paired_at = NOW(), last_seen_at = NOW() WHERE id = ? AND club_id = ?");
        $pairKiosk->bind_param('ssii', $pairingHash, $deviceName, $kioskId, $clubId);
        $pairKiosk->execute();
        $pairKiosk->close();

        $pairingId = (int) $pairing['id'];
        $approve = $db->prepare("UPDATE `{$requestsTable}` SET club_id = ?, status = 'approved', approved_kiosk_id = ?, approved_by_user_account_id = ?, approved_at = NOW(), consumed_at = NOW() WHERE id = ?");
        $approve->bind_param('iiii', $clubId, $kioskId, $userId, $pairingId);
        $approve->execute();
        $approve->close();

        $db->commit();

        $respond(['ok' => true, 'data' => ['created' => true, 'kiosk' => [
            'id' => $kioskId,
            'code' => (string) ($created['code'] ?? ''),
            'name' => $name,
            'board_number' => $boardNumber,
            'sponsor_label' => $sponsorLabel,
            'sponsor_logo_url' => $sponsorLogoUrl,
            'scoring_mode' => $scoringMode,
            'scolia_serial_number' => $scoringMode === 'scolia' ? $scoliaSerial : null,
            'device_name' => $deviceName,
        ]]], 201);
    } catch (Throwable $error) {
        $db->rollback();
        if ($error instanceof ValidationException) {
            $respond(['ok' => false, 'error' => ['code' => $error->errorCode(), 'message' => $error->getMessage()]], $error->statusCode());
        }
        if ($error instanceof mysqli_sql_exception && (int) $error->getCode() === 1062) {
            $respond(['ok' => false, 'error' => ['code' => 'scolia_serial_in_use', 'message' => 'Denne Scolia-ID-en er allerede knyttet til et annet board.']], 409);
        }
        if (!$error instanceof RuntimeException && !$error instanceof InvalidArgumentException) throw $error;
        $map = [
            'pairing_not_found' => [404, 'Pairingkoden finnes ikke.'],
            'pairing_expired' => [409, 'Pairingkoden er utløpt eller allerede brukt. Nettbrettet lager automatisk en ny kode.'],
            'pairing_other_club' => [403, 'Pairingforespørselen tilhører allerede en annen klubb.'],
            'board_number_exists' => [409, 'Dette boardnummeret finnes allerede. Velg eksisterende board eller bruk et annet nummer.'],
            'board_create_failed' => [500, 'Boardet kunne ikke opprettes.'],
            'scolia_serial_required' => [422, 'Scolia-board må ha en gyldig Scolia-ID / serienummer.'],
            'scolia_serial_in_use' => [409, 'Denne Scolia-ID-en er allerede knyttet til et annet board.'],
        ];
        [$status, $message] = $map[$error->getMessage()] ?? [422, $error instanceof InvalidArgumentException ? $error->getMessage() : 'Kunne ikke opprette og koble boardet.'];
        $respond(['ok' => false, 'error' => ['code' => $error->getMessage(), 'message' => $message]], $status);
    }
} catch (Throwable $error) {
    if (isset($db)) {
        try { $db->rollback(); } catch (Throwable) {}
    }
    $respond(['ok' => false, 'error' => [
        'code' => 'kiosk_create_and_pair_unavailable',
        'message' => 'Kunne ikke opprette og koble boardet.',
        'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
    ]], 500);
}