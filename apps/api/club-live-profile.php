<?php

declare(strict_types=1);

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
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (!in_array($method, ['PATCH', 'POST'], true)) {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'PATCH kreves.']], 405);
    }

    $config = Config::load(__DIR__);
    $database = new Database($config);
    $connection = $database->connection();

    $authorization = trim((string) ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if ($authorization === '' && function_exists('getallheaders')) {
        $headers = getallheaders();
        $authorization = trim((string) ($headers['Authorization'] ?? $headers['authorization'] ?? ''));
    }
    if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $tokenMatch) !== 1) {
        $respond(['ok' => false, 'error' => ['code' => 'authentication_required', 'message' => 'Du må være innlogget som klubbadministrator.']], 401);
    }

    $userRepository = new UserAccountRepository($database);
    $user = $userRepository->findBySessionToken(trim((string) $tokenMatch[1]));
    if ($user === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Innloggingen er utløpt eller ugyldig.']], 401);
    }

    $raw = file_get_contents('php://input');
    $payload = json_decode($raw !== false ? $raw : '', true);
    if (!is_array($payload)) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_json', 'message' => 'Ugyldig forespørsel.']], 400);
    }

    $clubId = (int) ($payload['club_id'] ?? 0);
    if ($clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'Velg en klubb.']], 422);
    }

    $role = (string) ($user['role'] ?? '');
    $canManage = $role === 'super_admin';
    if (!$canManage && $role === 'club_admin') {
        $managedIds = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($user['admin_club_ids'] ?? ''))
        ), static fn (int $id): bool => $id > 0));
        $canManage = in_array($clubId, $managedIds, true);
    }
    if (!$canManage) {
        $respond(['ok' => false, 'error' => ['code' => 'club_access_denied', 'message' => 'Du har ikke administratortilgang til denne klubben.']], 403);
    }

    $profile = trim((string) ($payload['live_display_profile'] ?? ''));
    $allowed = ['blindleia', 'broadcast-dark'];
    if (!in_array($profile, $allowed, true)) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_live_display_profile', 'message' => 'Ugyldig Live-profil.']], 422);
    }

    $table = $database->tablePrefix() . 'clubs';
    $statement = $connection->prepare(sprintf(
        'UPDATE `%s` SET live_display_profile = ?, updated_at = NOW() WHERE id = ?',
        $table
    ));
    $statement->bind_param('si', $profile, $clubId);
    $statement->execute();
    $statement->close();

    $read = $connection->prepare(sprintf(
        'SELECT id, name, slug, live_code, live_display_profile FROM `%s` WHERE id = ? LIMIT 1',
        $table
    ));
    $read->bind_param('i', $clubId);
    $read->execute();
    $club = $read->get_result()->fetch_assoc() ?: null;
    $read->close();

    if ($club === null) {
        $respond(['ok' => false, 'error' => ['code' => 'club_not_found', 'message' => 'Klubben finnes ikke.']], 404);
    }

    $respond(['ok' => true, 'data' => ['club' => [
        'id' => (int) $club['id'],
        'name' => (string) $club['name'],
        'slug' => (string) $club['slug'],
        'live_code' => (string) ($club['live_code'] ?? ''),
        'live_display_profile' => (string) $club['live_display_profile'],
    ]]]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'club_live_profile_unavailable',
            'message' => 'Kunne ikke lagre Live-profilen.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
