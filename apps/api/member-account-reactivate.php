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

$adminClubIds = static function (array $user): array {
    $ids = [];
    foreach (explode(',', (string) ($user['admin_club_ids'] ?? '')) as $value) {
        $id = (int) trim($value);
        if ($id > 0) $ids[$id] = $id;
    }
    return array_values($ids);
};

$canManageClub = static function (array $user, int $clubId) use ($adminClubIds): bool {
    if ((string) ($user['role'] ?? '') === 'super_admin') return true;
    if (in_array($clubId, $adminClubIds($user), true)) return true;
    return (string) ($user['role'] ?? '') === 'club_admin' && (int) ($user['player_club_id'] ?? 0) === $clubId;
};

try {
    $request = Request::fromGlobals();
    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'POST kreves.']], 405);
    }

    $config = Config::load(__DIR__);
    $database = new Database($config);
    $users = new UserAccountRepository($database);
    $sessionToken = $request->bearerToken();
    if ($sessionToken === null || trim($sessionToken) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'login_required', 'message' => 'Innlogging kreves.']], 401);
    }

    $currentUser = $users->findBySessionToken($sessionToken);
    if ($currentUser === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen er ugyldig eller utløpt.']], 401);
    }

    $payload = $request->jsonBody();
    $clubId = (int) ($payload['club_id'] ?? 0);
    $memberId = (int) ($payload['member_id'] ?? 0);
    if ($clubId <= 0 || $memberId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_request', 'message' => 'Klubb og medlem må angis.']], 422);
    }
    if (!$canManageClub($currentUser, $clubId)) {
        $respond(['ok' => false, 'error' => ['code' => 'forbidden', 'message' => 'Du har ikke administratortilgang til denne klubben.']], 403);
    }

    $db = $database->connection();
    $identityPrefix = $database->identityTablePrefix();
    $accounts = $identityPrefix . 'user_accounts';

    $stmt = $db->prepare("SELECT id, email, password_hash, account_status FROM `{$accounts}` WHERE member_id=? LIMIT 1");
    $stmt->bind_param('i', $memberId);
    $stmt->execute();
    $account = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    if ($account === null) {
        $respond(['ok' => false, 'error' => ['code' => 'account_not_found', 'message' => 'Medlemmet har ingen brukerkonto. Send en aktiveringslenke i stedet.']], 404);
    }

    $status = (string) ($account['account_status'] ?? '');
    if ($status === 'active') {
        $respond(['ok' => true, 'data' => ['status' => 'active', 'email' => $account['email']]]);
    }
    if ($status !== 'disabled') {
        $respond(['ok' => false, 'error' => ['code' => 'account_not_reactivatable', 'message' => 'Kontoen er ikke ferdig aktivert. Lag en ny aktiveringslenke i stedet.']], 422);
    }
    if (trim((string) ($account['email'] ?? '')) === '' || trim((string) ($account['password_hash'] ?? '')) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'account_not_claimed', 'message' => 'Kontoen mangler ferdig aktivering. Lag en ny aktiveringslenke i stedet.']], 422);
    }

    $active = 'active';
    $accountId = (int) $account['id'];
    $update = $db->prepare("UPDATE `{$accounts}` SET account_status=?, is_active=1 WHERE id=?");
    $update->bind_param('si', $active, $accountId);
    $update->execute();
    $update->close();

    $respond(['ok' => true, 'data' => [
        'status' => 'active',
        'account_id' => $accountId,
        'member_id' => $memberId,
        'email' => (string) $account['email'],
    ]]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'reactivation_unavailable',
            'message' => 'Kontoen kunne ikke aktiveres på nytt.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
