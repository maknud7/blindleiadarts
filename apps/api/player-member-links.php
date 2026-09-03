<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\PlayerMemberLinkRepository;
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
    $users = new UserAccountRepository($database);

    $token = $request->bearerToken();
    if ($token === null || trim($token) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'authentication_required', 'message' => 'Innlogging kreves.']], 401);
    }
    $user = $users->findBySessionToken($token);
    if ($user === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Innloggingen er ugyldig eller utløpt.']], 401);
    }

    $payload = $request->method() === 'POST' ? $request->jsonBody() : [];
    $clubId = $request->method() === 'GET'
        ? (int) ($_GET['club_id'] ?? 0)
        : (int) ($payload['club_id'] ?? 0);
    if ($clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'Klubb må velges.']], 422);
    }

    $role = (string) ($user['role'] ?? 'player');
    if ($role !== 'super_admin') {
        $adminIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if ($role !== 'club_admin' || !in_array($clubId, $adminIds, true)) {
            $respond(['ok' => false, 'error' => ['code' => 'club_admin_required', 'message' => 'Klubbadmin-tilgang kreves.']], 403);
        }
    }

    $links = new PlayerMemberLinkRepository($database);
    if ($request->method() === 'GET') {
        $respond(['ok' => true, 'data' => $links->overview($clubId)]);
    }
    if ($request->method() === 'POST') {
        $result = $links->link(
            $clubId,
            (int) ($payload['player_id'] ?? 0),
            (int) ($payload['member_id'] ?? 0),
            (int) ($user['id'] ?? 0)
        );
        $respond(['ok' => true, 'data' => $result]);
    }

    $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden er ikke tillatt.']], 405);
} catch (InvalidArgumentException $error) {
    $respond(['ok' => false, 'error' => ['code' => 'invalid_player_member_link', 'message' => $error->getMessage()]], 422);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'player_member_link_unavailable',
            'message' => 'Spillerkobling er midlertidig utilgjengelig.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
