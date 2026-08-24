<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$host = getenv('DB_HOST') ?: '';
$port = (int) (getenv('DB_PORT') ?: 3306);
$dbName = getenv('DB_NAME') ?: '';
$username = getenv('DB_USERNAME') ?: '';
$password = getenv('DB_PASSWORD') ?: '';
$prefix = getenv('DB_TABLE_PREFIX') ?: '';

if ($prefix !== 'bd_test_') {
    throw new RuntimeException('Pilot finalizer is allowed only for bd_test_.');
}

$mysqli = new mysqli($host, $username, $password, $dbName, $port);
$mysqli->set_charset('utf8mb4');

$users = $prefix . 'user_accounts';
$players = $prefix . 'players';
$roles = $prefix . 'global_user_roles';
$invites = $prefix . 'user_onboarding_invitations';
$sessions = $prefix . 'auth_sessions';
$displayName = 'Magnus Knudsen';

$stmt = $mysqli->prepare(
    "SELECT ua.id, ua.member_id, ua.player_id, ua.email, ua.password_hash,
            ua.account_status, ua.is_active, ua.claimed_at, p.member_id AS player_member_id,
            EXISTS(SELECT 1 FROM `{$roles}` r WHERE r.user_account_id=ua.id AND r.role='super_admin') AS has_super_admin,
            (SELECT COUNT(*) FROM `{$invites}` i WHERE i.user_account_id=ua.id AND i.used_at IS NOT NULL) AS used_invites
     FROM `{$users}` ua
     LEFT JOIN `{$players}` p ON p.id=ua.player_id
     WHERE ua.display_name=?
     LIMIT 2"
);
$stmt->bind_param('s', $displayName);
$stmt->execute();
$result = $stmt->get_result();
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}
$stmt->close();

if (count($rows) !== 1) {
    throw new RuntimeException('Expected exactly one pilot superadmin account.');
}

$row = $rows[0];
$accountId = (int)$row['id'];
$memberId = (int)($row['member_id'] ?? 0);

if ((string)$row['account_status'] !== 'active' || (int)$row['is_active'] !== 1) {
    throw new RuntimeException('Pilot account is not active.');
}
if (trim((string)($row['email'] ?? '')) === '' || trim((string)($row['password_hash'] ?? '')) === '' || trim((string)($row['claimed_at'] ?? '')) === '') {
    throw new RuntimeException('Pilot onboarding is not fully claimed.');
}
if ($memberId <= 0 || ($row['player_id'] !== null && (int)($row['player_member_id'] ?? 0) !== $memberId)) {
    throw new RuntimeException('Pilot identity links are inconsistent.');
}
if ((int)$row['has_super_admin'] !== 1 || (int)$row['used_invites'] < 1) {
    throw new RuntimeException('Pilot grant or consumed invitation is missing.');
}

$mysqli->begin_transaction();
try {
    $revokeInvites = $mysqli->prepare(
        "UPDATE `{$invites}` SET revoked_at=NOW()
         WHERE user_account_id=? AND used_at IS NULL AND revoked_at IS NULL"
    );
    $revokeInvites->bind_param('i', $accountId);
    $revokeInvites->execute();
    $revokedInvites = $revokeInvites->affected_rows;
    $revokeInvites->close();

    $revokeSessions = $mysqli->prepare(
        "UPDATE `{$sessions}` SET revoked_at=NOW()
         WHERE user_account_id=? AND revoked_at IS NULL"
    );
    $revokeSessions->bind_param('i', $accountId);
    $revokeSessions->execute();
    $revokedSessions = $revokeSessions->affected_rows;
    $revokeSessions->close();

    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    throw $error;
}

echo 'PILOT_UNUSED_INVITES_REVOKED=' . $revokedInvites . "\n";
echo 'PILOT_OLD_SESSIONS_REVOKED=' . $revokedSessions . "\n";
echo "PILOT_ONBOARDING_FINALIZED=yes\n";
