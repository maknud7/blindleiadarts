<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\MemberOnboardingRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

$apiRoot = dirname(__DIR__, 2) . '/apps/api';
$config = Config::load($apiRoot);
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();

if ($prefix !== 'bd_test_') {
    throw new RuntimeException('Onboarding flow smoke may only run against bd_test_.');
}

$users = $prefix . 'user_accounts';
$players = $prefix . 'players';
$clubs = $prefix . 'clubs';
$roles = $prefix . 'global_user_roles';
$invitations = $prefix . 'user_onboarding_invitations';
$sessions = $prefix . 'auth_sessions';

$club = $db->query("SELECT id FROM `{$clubs}` ORDER BY id ASC LIMIT 1")->fetch_assoc();
if ($club === null) {
    throw new RuntimeException('No test club available for onboarding smoke.');
}
$clubId = (int) $club['id'];

$admin = $db->query(
    "SELECT ua.id
     FROM `{$users}` ua
     INNER JOIN `{$roles}` gr ON gr.user_account_id=ua.id AND gr.role='super_admin'
     WHERE ua.account_status='active' AND ua.is_active=1
     ORDER BY ua.id ASC LIMIT 1"
)->fetch_assoc();
if ($admin === null) {
    throw new RuntimeException('No active test superadmin available for onboarding smoke.');
}
$adminId = (int) $admin['id'];

$candidate = $db->query(
    "SELECT m.id, m.navn
     FROM `medlemmer` m
     WHERE NOT EXISTS (
         SELECT 1 FROM `{$users}` ua WHERE ua.member_id=m.id
     )
       AND NOT EXISTS (
         SELECT 1
         FROM `{$players}` p
         INNER JOIN `{$users}` ua2 ON ua2.player_id=p.id
         WHERE p.member_id=m.id
     )
     ORDER BY m.id ASC
     LIMIT 1"
)->fetch_assoc();
if ($candidate === null) {
    echo "ONBOARDING_FLOW_SMOKE_SKIPPED=no-clean-member-candidate\n";
    exit(0);
}

$memberId = (int) $candidate['id'];
$memberName = (string) $candidate['navn'];
$repository = new MemberOnboardingRepository($database);
$accountId = null;

try {
    $invitation = $repository->createInvitation($clubId, $memberId, $adminId, null);
    $accountId = (int) $invitation['account']['id'];
    $token = (string) $invitation['token'];

    if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
        throw new RuntimeException('Invitation token format is invalid.');
    }
    if (($invitation['account']['status'] ?? null) !== 'invited') {
        throw new RuntimeException('Account did not enter invited state.');
    }

    $inspection = $repository->inspectInvitation($token);
    if ((int) ($inspection['member']['id'] ?? 0) !== $memberId) {
        throw new RuntimeException('Invitation does not resolve to the same membership.');
    }

    $email = sprintf('bd-onboarding-smoke-%d-%s@example.invalid', $memberId, bin2hex(random_bytes(4)));
    $password = 'Onboarding-Smoke-2026!';
    $completed = $repository->completeInvitation($token, $email, $password);

    if (($completed['account']['status'] ?? null) !== 'active') {
        throw new RuntimeException('Completed account is not active.');
    }
    if ((int) ($completed['member']['id'] ?? 0) !== $memberId) {
        throw new RuntimeException('Completed account changed membership identity.');
    }

    $accountStmt = $db->prepare(
        "SELECT email, password_hash, member_id, account_status, is_active FROM `{$users}` WHERE id=? LIMIT 1"
    );
    $accountStmt->bind_param('i', $accountId);
    $accountStmt->execute();
    $account = $accountStmt->get_result()->fetch_assoc() ?: null;
    $accountStmt->close();
    if ($account === null) {
        throw new RuntimeException('Completed account disappeared.');
    }
    if ((string) $account['email'] !== $email) {
        throw new RuntimeException('Completed account email mismatch.');
    }
    if ((int) $account['member_id'] !== $memberId) {
        throw new RuntimeException('Completed account member_id mismatch.');
    }
    if ((string) $account['account_status'] !== 'active' || (int) $account['is_active'] !== 1) {
        throw new RuntimeException('Completed account activation flags are invalid.');
    }
    if (!password_verify($password, (string) $account['password_hash'])) {
        throw new RuntimeException('Completed account password hash cannot verify password.');
    }

    $tokenRejected = false;
    try {
        $repository->inspectInvitation($token);
    } catch (InvalidArgumentException) {
        $tokenRejected = true;
    }
    if (!$tokenRejected) {
        throw new RuntimeException('Used invitation token is still accepted.');
    }

    echo 'ONBOARDING_FLOW member=' . $memberId . ' name=' . $memberName . ' account=' . $accountId . PHP_EOL;
    echo "ONBOARDING_FLOW_SMOKE_OK=yes\n";
} finally {
    if ($accountId !== null && $accountId > 0) {
        $deleteInvites = $db->prepare("DELETE FROM `{$invitations}` WHERE user_account_id=?");
        $deleteInvites->bind_param('i', $accountId);
        $deleteInvites->execute();
        $deleteInvites->close();

        $deleteSessions = $db->prepare("DELETE FROM `{$sessions}` WHERE user_account_id=?");
        $deleteSessions->bind_param('i', $accountId);
        $deleteSessions->execute();
        $deleteSessions->close();

        $deleteAccount = $db->prepare("DELETE FROM `{$users}` WHERE id=?");
        $deleteAccount->bind_param('i', $accountId);
        $deleteAccount->execute();
        $deleteAccount->close();
    }
}
