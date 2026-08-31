<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

$request = Request::fromGlobals();

try {
    $config = Config::load(__DIR__);
    if ($config->appEnv() !== 'test') {
        JsonResponse::error(404, 'not_found', 'Not found.')->send();
        exit;
    }
    if ($request->method() !== 'GET') {
        JsonResponse::error(405, 'method_not_allowed', 'Only GET is supported.')->send();
        exit;
    }

    $database = new Database($config);
    $token = $request->bearerToken();
    if ($token === null) {
        JsonResponse::error(401, 'authentication_required', 'Authentication is required.')->send();
        exit;
    }

    $users = new UserAccountRepository($database);
    $user = $users->findBySessionToken($token);
    if ($user === null) {
        JsonResponse::error(401, 'invalid_session', 'The session is invalid or expired.')->send();
        exit;
    }

    $clubId = isset($_GET['club_id']) ? (int) $_GET['club_id'] : 0;
    if ($clubId <= 0) {
        JsonResponse::error(422, 'club_required', 'club_id is required.')->send();
        exit;
    }

    $role = (string) ($user['role'] ?? 'player');
    if ($role !== 'super_admin') {
        $adminClubIds = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($user['admin_club_ids'] ?? ''))
        )));
        if ($role !== 'club_admin' || !in_array($clubId, $adminClubIds, true)) {
            JsonResponse::error(403, 'club_admin_required', 'Club administrator access is required.')->send();
            exit;
        }
    }

    $dataPrefix = $database->tablePrefix();
    $identityPrefix = $database->identityTablePrefix();
    foreach ([$dataPrefix, $identityPrefix] as $prefix) {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
    }
    if ($dataPrefix === $identityPrefix) {
        throw new RuntimeException('TEST player candidates require shared PROD identity.');
    }

    $localPlayers = $dataPrefix . 'players';
    $localClubs = $dataPrefix . 'clubs';
    $identityPlayers = $identityPrefix . 'players';
    $identityClubs = $identityPrefix . 'clubs';
    $identityUsers = $identityPrefix . 'user_accounts';

    $sql = "SELECT
                tp.id,
                ip.display_name,
                ip.first_name,
                ip.last_name,
                ip.nickname,
                ip.avatar_url,
                tp.member_id,
                1 AS is_active,
                'prod_identity' AS identity_source
            FROM `{$localPlayers}` tp
            INNER JOIN `{$localClubs}` tc ON tc.id=tp.club_id
            INNER JOIN `{$identityClubs}` ic ON ic.slug=tc.slug
            INNER JOIN `{$identityPlayers}` ip ON ip.id=(
                SELECT MIN(ip2.id)
                FROM `{$identityPlayers}` ip2
                WHERE ip2.club_id=ic.id
                  AND ip2.member_id=tp.member_id
                  AND ip2.is_active=1
                  AND ip2.merged_into_player_id IS NULL
            )
            WHERE tp.club_id=?
              AND tp.member_id IS NOT NULL
              AND tp.is_active=1
              AND tp.merged_into_player_id IS NULL
              AND tp.id=(
                  SELECT MIN(tp2.id)
                  FROM `{$localPlayers}` tp2
                  WHERE tp2.club_id=tp.club_id
                    AND tp2.member_id=tp.member_id
                    AND tp2.is_active=1
                    AND tp2.merged_into_player_id IS NULL
              )
              AND EXISTS (
                  SELECT 1
                  FROM `{$identityUsers}` ua
                  LEFT JOIN `{$identityPlayers}` uap ON uap.id=ua.player_id
                  WHERE ua.is_active=1
                    AND ua.account_status='active'
                    AND COALESCE(ua.member_id,uap.member_id)=tp.member_id
              )
            ORDER BY ip.display_name ASC";

    $statement = $database->connection()->prepare($sql);
    $statement->bind_param('i', $clubId);
    $statement->execute();
    $items = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
    $statement->close();

    JsonResponse::ok([
        'club_id' => $clubId,
        'identity_source' => 'prod',
        'items' => $items,
    ])->send();
} catch (Throwable $error) {
    $exposeDetails = isset($config) && $config instanceof Config && $config->appEnv() === 'test';
    JsonResponse::error(
        500,
        'test_player_candidates_failed',
        'Could not load canonical TEST player candidates.',
        $exposeDetails ? ['details' => $error->getMessage()] : []
    )->send();
}
