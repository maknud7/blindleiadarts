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
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $request = Request::fromGlobals();
    $repository = new MemberOnboardingRepository($database);
    $action = strtolower(trim((string) ($_GET['action'] ?? '')));

    $loadMembership = static function (int $memberId, bool $includePayments = false) use ($db): ?array {
        if ($memberId <= 0) return null;
        $stmt = $db->prepare(
            'SELECT id, medlemsnummer, navn, innmeldingsdato, rolle, betalingsstatus_override, kontingent_start, kontingent_slutt, maanedsbelop
             FROM `medlemmer` WHERE id=? LIMIT 1'
        );
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $member = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($member === null) return null;

        $memberNumber = (int) ($member['medlemsnummer'] ?? 0);
        $latest = null;
        $payments = [];
        if ($memberNumber > 0) {
            $limit = $includePayments ? 24 : 1;
            $paymentSql = 'SELECT dato, periode, belop, kilde FROM `kontingentbetalinger` WHERE medlemsnummer=? ORDER BY dato DESC, id DESC LIMIT ' . $limit;
            $paymentStmt = $db->prepare($paymentSql);
            $paymentStmt->bind_param('i', $memberNumber);
            $paymentStmt->execute();
            $payments = $paymentStmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $paymentStmt->close();
            $latest = $payments[0] ?? null;
        }

        return [
            'member_id' => (int) $member['id'],
            'member_number' => $memberNumber,
            'joined_at' => $member['innmeldingsdato'],
            'role' => $member['rolle'],
            'status_override' => $member['betalingsstatus_override'],
            'dues_start' => $member['kontingent_start'],
            'dues_end' => $member['kontingent_slutt'],
            'monthly_amount' => $member['maanedsbelop'] !== null ? (float) $member['maanedsbelop'] : null,
            'latest_payment' => $latest !== null ? [
                'date' => $latest['dato'],
                'period' => $latest['periode'],
                'amount' => $latest['belop'] !== null ? (float) $latest['belop'] : null,
                'source' => $latest['kilde'],
            ] : null,
            'payments' => $includePayments ? array_map(static fn (array $row): array => [
                'date' => $row['dato'],
                'period' => $row['periode'],
                'amount' => $row['belop'] !== null ? (float) $row['belop'] : null,
                'source' => $row['kilde'],
            ], $payments) : [],
        ];
    };

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

    $sessionToken = $request->bearerToken();
    if ($sessionToken === null || trim($sessionToken) === '') {
        $respond(['ok' => false, 'error' => ['code' => 'login_required', 'message' => 'Innlogging kreves.']], 401);
    }
    $users = new UserAccountRepository($database);
    $currentUser = $users->findBySessionToken($sessionToken);
    if ($currentUser === null) {
        $respond(['ok' => false, 'error' => ['code' => 'invalid_session', 'message' => 'Sesjonen er ugyldig eller utløpt.']], 401);
    }

    if ($request->method() === 'GET' && $action === 'self') {
        $memberId = (int) ($currentUser['member_id'] ?? 0);
        $respond(['ok' => true, 'data' => [
            'membership' => $loadMembership($memberId, true),
            'player_id' => (int) ($currentUser['player_id'] ?? 0),
        ]]);
    }

    $clubId = $request->method() === 'GET'
        ? (int) ($_GET['club_id'] ?? 0)
        : (int) (($request->jsonBody()['club_id'] ?? 0));
    if ($clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'club_required', 'message' => 'Klubb må velges.']], 422);
    }
    if (!$canManageClub($currentUser, $clubId)) {
        $respond(['ok' => false, 'error' => ['code' => 'forbidden', 'message' => 'Du har ikke administratortilgang til denne klubben.']], 403);
    }

    if ($request->method() === 'GET' && $action === 'list') {
        $data = $repository->listMembers($clubId);
        foreach ($data['items'] as &$item) {
            $item['membership'] = $loadMembership((int) ($item['member_id'] ?? 0), false);
        }
        unset($item);
        $respond(['ok' => true, 'data' => $data]);
    }

    if ($request->method() === 'POST' && $action === 'invite') {
        $payload = $request->jsonBody();
        $memberId = (int) ($payload['member_id'] ?? 0);
        if ($memberId <= 0) throw new InvalidArgumentException('Ugyldig spiller.');

        // Club people are one durable identity: membership + player profile + login.
        // Tournament-only opponents can remain guest player rows for historical stats.
        $playersTable = $prefix . 'players';
        $memberStmt = $db->prepare('SELECT id, navn FROM `medlemmer` WHERE id=? LIMIT 1');
        $memberStmt->bind_param('i', $memberId);
        $memberStmt->execute();
        $member = $memberStmt->get_result()->fetch_assoc() ?: null;
        $memberStmt->close();
        if ($member === null) throw new InvalidArgumentException('Spilleren finnes ikke i medlemsregisteret.');

        $playerStmt = $db->prepare("SELECT id FROM `{$playersTable}` WHERE club_id=? AND member_id=? ORDER BY id ASC LIMIT 1");
        $playerStmt->bind_param('ii', $clubId, $memberId);
        $playerStmt->execute();
        $player = $playerStmt->get_result()->fetch_assoc() ?: null;
        $playerStmt->close();
        if ($player === null) {
            $displayName = trim((string) $member['navn']);
            $insertPlayer = $db->prepare("INSERT INTO `{$playersTable}` (club_id, display_name, is_active, member_id) VALUES (?, ?, 1, ?)");
            $insertPlayer->bind_param('isi', $clubId, $displayName, $memberId);
            $insertPlayer->execute();
            $insertPlayer->close();
        }

        $result = $repository->createInvitation(
            $clubId,
            $memberId,
            (int) $currentUser['id'],
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
    $respond(['ok' => false, 'error' => ['code' => 'invalid_onboarding_request', 'message' => $error->getMessage()]], $status);
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