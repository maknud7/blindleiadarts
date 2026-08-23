<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ScreenRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;

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
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $request = Request::fromGlobals();

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

    $clubsTable = $prefix . 'clubs';
    $playersTable = $prefix . 'players';
    $tournamentsTable = $prefix . 'tournaments';
    $matchesTable = $prefix . 'matches';
    $referencesTable = $prefix . 'external_references';

    $clubStatement = $db->prepare("SELECT id, name, slug, logo_url FROM `{$clubsTable}` WHERE id = ? LIMIT 1");
    $clubStatement->bind_param('i', $clubId);
    $clubStatement->execute();
    $club = $clubStatement->get_result()->fetch_assoc() ?: null;
    $clubStatement->close();
    if ($club === null) {
        $respond(['ok' => false, 'error' => ['code' => 'club_not_found', 'message' => 'Klubben finnes ikke.']], 404);
    }

    $membership = new MembershipDatabase($config, $database, $config->dartsAtlas()->membersTable());
    $members = $membership->listMembers();
    $memberMap = [];
    foreach ($members as $member) {
        $memberMap[(int) $member['id']] = (string) $member['navn'];
    }

    if ($request->method() === 'POST') {
        $action = trim((string) ($_GET['action'] ?? ''));
        if ($action !== 'member-link') {
            $respond(['ok' => false, 'error' => ['code' => 'unknown_action', 'message' => 'Ukjent handling.']], 404);
        }

        $payload = $request->jsonBody();
        $playerId = (int) ($payload['player_id'] ?? 0);
        $memberIdRaw = $payload['member_id'] ?? null;
        $memberId = ($memberIdRaw === null || $memberIdRaw === '' || (int) $memberIdRaw <= 0)
            ? null
            : (int) $memberIdRaw;

        if ($playerId <= 0) {
            $respond(['ok' => false, 'error' => ['code' => 'player_required', 'message' => 'Spiller mangler.']], 422);
        }

        $playerStatement = $db->prepare("SELECT id, display_name FROM `{$playersTable}` WHERE id = ? AND club_id = ? LIMIT 1");
        $playerStatement->bind_param('ii', $playerId, $clubId);
        $playerStatement->execute();
        $player = $playerStatement->get_result()->fetch_assoc() ?: null;
        $playerStatement->close();
        if ($player === null) {
            $respond(['ok' => false, 'error' => ['code' => 'player_not_found', 'message' => 'Spilleren finnes ikke i valgt klubb.']], 404);
        }

        $member = null;
        if ($memberId !== null) {
            $member = $membership->findMemberById($memberId);
            if ($member === null) {
                $respond(['ok' => false, 'error' => ['code' => 'member_not_found', 'message' => 'Medlemmet finnes ikke i det delte medlemsregisteret.']], 422);
            }

            $duplicate = $db->prepare("SELECT id, display_name FROM `{$playersTable}` WHERE member_id = ? AND id <> ? LIMIT 1");
            $duplicate->bind_param('ii', $memberId, $playerId);
            $duplicate->execute();
            $existing = $duplicate->get_result()->fetch_assoc() ?: null;
            $duplicate->close();
            if ($existing !== null) {
                $respond([
                    'ok' => false,
                    'error' => [
                        'code' => 'member_already_linked',
                        'message' => sprintf('Medlemmet er allerede koblet til %s.', (string) $existing['display_name']),
                    ],
                ], 409);
            }
        }

        if ($memberId === null) {
            $update = $db->prepare("UPDATE `{$playersTable}` SET member_id = NULL, member_link_source = NULL, member_linked_at = NULL WHERE id = ? AND club_id = ?");
            $update->bind_param('ii', $playerId, $clubId);
        } else {
            $source = 'manual';
            $update = $db->prepare("UPDATE `{$playersTable}` SET member_id = ?, member_link_source = ?, member_linked_at = NOW() WHERE id = ? AND club_id = ?");
            $update->bind_param('isii', $memberId, $source, $playerId, $clubId);
        }
        $update->execute();
        $update->close();

        $respond([
            'ok' => true,
            'data' => [
                'player_id' => $playerId,
                'player_name' => (string) $player['display_name'],
                'member' => $member,
                'link_source' => $memberId === null ? null : 'manual',
            ],
        ]);
    }

    if ($request->method() !== 'GET') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $playerSql = "SELECT
            p.id,
            p.display_name,
            p.nickname,
            p.member_id,
            p.member_link_source,
            p.member_linked_at,
            p.is_active,
            er.external_id AS dartsatlas_external_id
        FROM `{$playersTable}` p
        LEFT JOIN `{$referencesTable}` er
          ON er.external_system = 'dartsatlas'
         AND er.external_entity_type = 'player'
         AND er.internal_entity_type = 'player'
         AND er.internal_id = p.id
        WHERE p.club_id = ?
        ORDER BY p.display_name ASC";
    $playerStatement = $db->prepare($playerSql);
    $playerStatement->bind_param('i', $clubId);
    $playerStatement->execute();
    $playerRows = $playerStatement->get_result()->fetch_all(MYSQLI_ASSOC);
    $playerStatement->close();

    $players = [];
    $linkedCount = 0;
    $dartsAtlasCount = 0;
    foreach ($playerRows as $row) {
        $memberId = isset($row['member_id']) && $row['member_id'] !== null ? (int) $row['member_id'] : null;
        if ($memberId !== null) {
            $linkedCount++;
        }
        if (!empty($row['dartsatlas_external_id'])) {
            $dartsAtlasCount++;
        }
        $players[] = [
            'id' => (int) $row['id'],
            'display_name' => (string) $row['display_name'],
            'nickname' => $row['nickname'] ?? null,
            'member_id' => $memberId,
            'member_name' => $memberId !== null ? ($memberMap[$memberId] ?? null) : null,
            'member_link_source' => $row['member_link_source'] ?? null,
            'member_linked_at' => $row['member_linked_at'] ?? null,
            'dartsatlas_external_id' => $row['dartsatlas_external_id'] ?? null,
            'is_active' => (int) ($row['is_active'] ?? 0),
        ];
    }

    $tournamentSql = "SELECT
            t.id,
            t.name,
            t.status,
            t.start_at,
            t.end_at,
            t.season_id,
            er.external_id AS dartsatlas_external_id,
            COUNT(DISTINCT m.id) AS match_count,
            COUNT(DISTINCT CASE WHEN m.status = 'completed' THEN m.id END) AS completed_match_count
        FROM `{$tournamentsTable}` t
        LEFT JOIN `{$matchesTable}` m ON m.tournament_id = t.id
        LEFT JOIN `{$referencesTable}` er
          ON er.external_system = 'dartsatlas'
         AND er.external_entity_type = 'tournament'
         AND er.internal_entity_type = 'tournament'
         AND er.internal_id = t.id
        WHERE t.club_id = ? AND t.provider_system = 'dartsatlas'
        GROUP BY t.id, t.name, t.status, t.start_at, t.end_at, t.season_id, er.external_id
        ORDER BY COALESCE(t.start_at, t.updated_at) DESC, t.id DESC
        LIMIT 30";
    $tournamentStatement = $db->prepare($tournamentSql);
    $tournamentStatement->bind_param('i', $clubId);
    $tournamentStatement->execute();
    $tournaments = $tournamentStatement->get_result()->fetch_all(MYSQLI_ASSOC);
    $tournamentStatement->close();

    $screens = (new ScreenRepository($database))->listByClubId($clubId);

    $respond([
        'ok' => true,
        'data' => [
            'club' => [
                'id' => (int) $club['id'],
                'name' => (string) $club['name'],
                'slug' => (string) $club['slug'],
                'logo_url' => $club['logo_url'] ?? null,
            ],
            'dartsatlas' => [
                'season_external_id' => $config->dartsAtlas()->seasonId(),
                'poll_interval_seconds' => $config->dartsAtlas()->pollIntervalSeconds(),
                'tournament_count' => count($tournaments),
                'player_count' => $dartsAtlasCount,
            ],
            'member_registry' => [
                'source' => $membership->source(),
                'available' => $membership->connection() instanceof mysqli,
                'member_count' => count($members),
                'linked_player_count' => $linkedCount,
                'unlinked_player_count' => max(0, count($players) - $linkedCount),
            ],
            'players' => $players,
            'members' => $members,
            'tournaments' => array_map(static fn (array $row): array => [
                'id' => (int) $row['id'],
                'name' => (string) $row['name'],
                'status' => (string) $row['status'],
                'start_at' => $row['start_at'] ?? null,
                'end_at' => $row['end_at'] ?? null,
                'season_id' => isset($row['season_id']) && $row['season_id'] !== null ? (int) $row['season_id'] : null,
                'dartsatlas_external_id' => $row['dartsatlas_external_id'] ?? null,
                'match_count' => (int) ($row['match_count'] ?? 0),
                'completed_match_count' => (int) ($row['completed_match_count'] ?? 0),
            ], $tournaments),
            'screens' => $screens,
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_admin_unavailable',
            'message' => 'DartsAtlas-admin kunne ikke lastes.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
