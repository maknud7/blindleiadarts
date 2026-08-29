<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\MemberAdminRepository;
use Blindleia\Dartkiosk\Api\Repository\MemberOnboardingRepository;
use Blindleia\Dartkiosk\Api\Repository\MembershipAdminStatusRepository;
use Blindleia\Dartkiosk\Api\Repository\SelfRegistrationRepository;
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
    $memberAdmin = new MemberAdminRepository($database);
    $membershipAdminStatus = new MembershipAdminStatusRepository($database);
    $selfRegistration = new SelfRegistrationRepository($database);
    $action = strtolower(trim((string) ($_GET['action'] ?? '')));

    // Kept for the legacy `self` payload only. The club-admin list below uses
    // MembershipAdminStatusRepository, which mirrors blindleia-admin's canonical
    // kontingentlogikk.php + medlemsarkiv.php rules.
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
        try {
            $data = $repository->inspectInvitation($token);
            $data['type'] = 'member';
        } catch (InvalidArgumentException) {
            $data = $selfRegistration->inspectInvitation($token);
        }
        $respond(['ok' => true, 'data' => $data]);
    }

    if ($request->method() === 'POST' && $action === 'complete') {
        $payload = $request->jsonBody();
        $token = trim((string) ($payload['token'] ?? ''));
        try {
            $selfRegistration->inspectInvitation($token);
            $result = $selfRegistration->submitInvitation(
                $token,
                trim((string) ($payload['first_name'] ?? '')),
                trim((string) ($payload['last_name'] ?? '')),
                trim((string) ($payload['email'] ?? '')),
                (string) ($payload['password'] ?? '')
            );
        } catch (InvalidArgumentException $selfError) {
            try {
                $repository->inspectInvitation($token);
            } catch (InvalidArgumentException) {
                throw $selfError;
            }
            $result = $repository->completeInvitation(
                $token,
                trim((string) ($payload['email'] ?? '')),
                (string) ($payload['password'] ?? '')
            );
            $result['type'] = 'member';
        }
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
        $data = $memberAdmin->listMembers($clubId);
        $activeMembers = 0;
        $inactiveMembers = 0;
        $requiresAction = 0;

        foreach ($data['items'] as &$item) {
            $membership = $membershipAdminStatus->forMember((int) ($item['member_id'] ?? 0));
            $item['membership'] = $membership;

            $isActiveMember = (bool) ($membership['is_active_member'] ?? true);
            if ($isActiveMember) {
                $activeMembers++;
            } else {
                $inactiveMembers++;
            }

            $accountStatus = (string) ($item['account']['status'] ?? 'none');
            $accountNeedsAction = $accountStatus !== 'active';
            if ($isActiveMember && ((bool) ($membership['needs_follow_up'] ?? false) || $accountNeedsAction)) {
                $requiresAction++;
            }
        }
        unset($item);

        $data['member_status_summary'] = [
            'active' => $activeMembers,
            'inactive' => $inactiveMembers,
            'requires_action' => $requiresAction,
        ];
        $data['permissions'] = [
            'current_user_account_id' => (int) ($currentUser['id'] ?? 0),
            'current_access_level' => (string) ($currentUser['role'] ?? 'player'),
            'can_manage_roles' => true,
            'can_grant_super_admin' => (string) ($currentUser['role'] ?? '') === 'super_admin',
        ];
        $data['pending_registrations'] = $selfRegistration->listPending($clubId);
        $respond(['ok' => true, 'data' => $data]);
    }

    if ($request->method() === 'POST' && $action === 'set-access-level') {
        $payload = $request->jsonBody();
        $result = $memberAdmin->setAccessLevel(
            $clubId,
            (int) ($payload['account_id'] ?? 0),
            (string) ($payload['access_level'] ?? ''),
            (int) ($currentUser['id'] ?? 0),
            (string) ($currentUser['role'] ?? '') === 'super_admin'
        );
        $respond(['ok' => true, 'data' => $result]);
    }

    if ($request->method() === 'POST' && $action === 'invite-open') {
        $result = $selfRegistration->createInvitation($clubId, (int) $currentUser['id']);
        $respond(['ok' => true, 'data' => $result], 201);
    }

    if ($request->method() === 'POST' && $action === 'approve-open') {
        $payload = $request->jsonBody();
        $result = $selfRegistration->approve(
            $clubId,
            (int) ($payload['invite_id'] ?? 0),
            (int) ($payload['member_id'] ?? 0),
            (int) $currentUser['id']
        );
        $respond(['ok' => true, 'data' => $result]);
    }

    if ($request->method() === 'POST' && $action === 'invite') {
        $payload = $request->jsonBody();
        $memberId = (int) ($payload['member_id'] ?? 0);
        if ($memberId <= 0) throw new InvalidArgumentException('Ugyldig spiller.');

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
        $memberId = (int) ($payload['member_id'] ?? 0);
        if ($memberId > 0 && $memberId === (int) ($currentUser['member_id'] ?? 0)) {
            throw new InvalidArgumentException('Du kan ikke deaktivere din egen brukerkonto her.');
        }
        $repository->disableAccount($memberId);
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
