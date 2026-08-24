<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\MemberOnboardingRepository;
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
        if ($id > 0) {
            $ids[$id] = $id;
        }
    }
    return array_values($ids);
};

$canManageClub = static function (array $user, int $clubId) use ($adminClubIds): bool {
    if ((string) ($user['role'] ?? '') === 'super_admin') {
        return true;
    }
    if (in_array($clubId, $adminClubIds($user), true)) {
        return true;
    }
    return (string) ($user['role'] ?? '') === 'club_admin'
        && (int) ($user['player_club_id'] ?? 0) === $clubId;
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $request = Request::fromGlobals();
    $repository = new MemberOnboardingRepository($database);
    $action = strtolower(trim((string) ($_GET['action'] ?? '')));

    if ($request->method() === 'GET' && $action === 'inspect') {
        $token = trim((string) ($_GET['token'] ?? ''));
        $respond(['ok' => true, 'data' => $repository->inspectInvitation($token)]);
    }

    if ($request->method() === 'POST' && $action === 'complete') {
        $payload = $request->jsonBody();
        $result = $repository->completeInvitation(
            trim((string) ($payload['token'] ?? '')),
            trim((string) ($payload['email'] ?? '')),
            (string) ($payload['password'] ?? '')
        );
        $respond(['ok' => true, 'data' => $result]);
    }

    $token = $request->bearerToken();
    if ($token === null || trim($token) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'login_required', 'message' => 'Innlogging kreves.']], 401);
    }

    $users = new UserAccountRepository($database);
    $admin = $users->findBySessionToken($token);
    if ($admin === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen er ugyldig eller utløpt.']], 401);
    }

    $clubId = $request->method() === 'GET'
        ? (int) ($_GET['club_id'] ?? 0)
        : (int) (($request->jsonBody()['club_id'] ?? 0));

    if ($clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'Klubb må velges.']], 422);
    }
    if (!$canManageClub($admin, $clubId)) {
        $respond(['ok' => false, 'error' => ['code' => 'forbidden', 'message' => 'Du har ikke administratortilgang til denne klubben.']], 403);
    }

    if ($request->method() === 'GET' && $action === 'list') {
        $respond(['ok' => true, 'data' => $repository->listMembers($clubId)]);
    }

    if ($request->method() === 'POST' && $action === 'invite') {
        $payload = $request->jsonBody();
        $result = $repository->createInvitation(
            $clubId,
            (int) ($payload['member_id'] ?? 0),
            (int) $admin['id'],
            isset($payload['email']) ? (string) $payload['email'] : null
        );
        $respond(['ok' => true, 'data' => $result], 201);
    }

    if ($request->method() === 'POST' && $action === 'disable') {
        $payload = $request->jsonBody();
        $repository->disableAccount((int) ($payload['member_id'] ?? 0));
        $respond(['ok' => true, 'data' => ['status' => 'disabled']]);
    }

    $respond(['ok' => false, 'error' => ['code' => 'not_found', 'message' => 'Onboarding-handlingen finnes ikke.']], 404);
} catch (InvalidArgumentException $error) {
    $status = in_array($action ?? '', ['inspect', 'complete'], true) ? 410 : 422;
    $respond([
        'ok' => false,
        'error' => ['code' => 'invalid_onboarding_request', 'message' => $error->getMessage()],
    ], $status);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'onboarding_unavailable',
            'message' => 'Onboarding er midlertidig utilgjengelig.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
