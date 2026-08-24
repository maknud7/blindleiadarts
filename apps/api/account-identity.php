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

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $request = Request::fromGlobals();

    if (!in_array($request->method(), ['GET', 'PATCH'], true)) {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $token = $request->bearerToken();
    if ($token === null || trim($token) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'login_required', 'message' => 'Innlogging kreves.']], 401);
    }

    $users = new UserAccountRepository($database);
    $user = $users->findBySessionToken($token);
    if ($user === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen er ugyldig eller utløpt.']], 401);
    }

    if ($request->method() === 'PATCH') {
        $payload = $request->jsonBody();
        $email = trim((string) ($payload['email'] ?? ''));
        if ($email === '') {
            $respond(['ok' => false, 'error' => ['code' => 'email_required', 'message' => 'E-postadresse må fylles ut.']], 422);
        }

        try {
            $users->updateEmail((int) $user['id'], $email);
        } catch (InvalidArgumentException $error) {
            $respond(['ok' => false, 'error' => ['code' => 'invalid_email', 'message' => $error->getMessage()]], 422);
        }

        $user = $users->findBySessionToken($token);
        if ($user === null) {
            $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen ble ugyldig.']], 401);
        }
    }

    $adminClubIds = [];
    foreach (explode(',', (string) ($user['admin_club_ids'] ?? '')) as $clubId) {
        $clubId = (int) trim($clubId);
        if ($clubId > 0) {
            $adminClubIds[$clubId] = $clubId;
        }
    }
    $adminClubIds = array_values($adminClubIds);
    sort($adminClubIds);

    $playerId = isset($user['player_id']) && $user['player_id'] !== null ? (int) $user['player_id'] : null;
    $playerClubId = isset($user['player_club_id']) && $user['player_club_id'] !== null ? (int) $user['player_club_id'] : null;
    $memberId = isset($user['player_member_id']) && $user['player_member_id'] !== null ? (int) $user['player_member_id'] : null;
    $superAdmin = (string) ($user['role'] ?? '') === 'super_admin';

    $respond([
        'ok' => true,
        'data' => [
            'account' => [
                'id' => (int) $user['id'],
                'username' => (string) ($user['username'] ?? ''),
                'email' => $user['email'] ?? null,
                'display_name' => (string) ($user['display_name'] ?? ''),
                'is_active' => (int) ($user['is_active'] ?? 0) === 1,
            ],
            'player' => $playerId !== null ? [
                'id' => $playerId,
                'display_name' => $user['player_display_name'] ?? null,
                'club_id' => $playerClubId,
            ] : null,
            'member' => $memberId !== null ? [
                'id' => $memberId,
                'link_source' => $user['player_member_link_source'] ?? null,
            ] : null,
            'permissions' => [
                'super_admin' => $superAdmin,
                'club_admin_ids' => $adminClubIds,
            ],
            'capabilities' => [
                'can_login' => true,
                'has_email_login' => isset($user['email']) && is_string($user['email']) && trim($user['email']) !== '',
                'is_player' => $playerId !== null,
                'is_member' => $memberId !== null,
                'can_use_player_portal' => $playerId !== null,
                'can_administer' => $superAdmin || $adminClubIds !== [],
            ],
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'identity_unavailable',
            'message' => 'Kunne ikke lese brukeridentiteten.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
