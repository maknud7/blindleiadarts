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
    throw new RuntimeException('First onboarding seed is allowed only for bd_test_.');
}

$mysqli = new mysqli($host, $username, $password, $dbName, $port);
$mysqli->set_charset('utf8mb4');

$users = $prefix . 'user_accounts';
$players = $prefix . 'players';
$globalRoles = $prefix . 'global_user_roles';
$invitations = $prefix . 'user_onboarding_invitations';

$displayName = 'Magnus Knudsen';
$tokenHash = '34121f871419f80a5125baf67b81e61b8f7647ba3757ff0817cfe4225e32101b';

$stmt = $mysqli->prepare(
    "SELECT ua.id AS account_id, ua.member_id AS account_member_id, p.member_id AS player_member_id
     FROM `{$users}` ua
     INNER JOIN `{$globalRoles}` gur
             ON gur.user_account_id = ua.id AND gur.role = 'super_admin'
     LEFT JOIN `{$players}` p ON p.id = ua.player_id
     WHERE ua.display_name = ?
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
    throw new RuntimeException('Expected exactly one matching active superadmin account.');
}

$accountId = (int) $rows[0]['account_id'];
$accountMemberId = $rows[0]['account_member_id'] !== null ? (int) $rows[0]['account_member_id'] : null;
$playerMemberId = $rows[0]['player_member_id'] !== null ? (int) $rows[0]['player_member_id'] : null;

if ($accountMemberId !== null && $playerMemberId !== null && $accountMemberId !== $playerMemberId) {
    throw new RuntimeException('Superadmin account and player point to different members.');
}

$memberId = $accountMemberId ?? $playerMemberId;
if ($memberId === null || $memberId <= 0) {
    throw new RuntimeException('Superadmin account is not linked to a canonical member yet.');
}

$memberCheck = $mysqli->prepare('SELECT id FROM `medlemmer` WHERE id = ? LIMIT 1');
$memberCheck->bind_param('i', $memberId);
$memberCheck->execute();
$memberExists = $memberCheck->get_result()->fetch_assoc() !== null;
$memberCheck->close();
if (!$memberExists) {
    throw new RuntimeException('Canonical member row does not exist.');
}

if ($accountMemberId === null) {
    $link = $mysqli->prepare("UPDATE `{$users}` SET member_id = ? WHERE id = ? AND member_id IS NULL");
    $link->bind_param('ii', $memberId, $accountId);
    $link->execute();
    $link->close();
}

$existing = $mysqli->prepare(
    "SELECT id, used_at, revoked_at, expires_at
     FROM `{$invitations}`
     WHERE token_hash = ? AND user_account_id = ?
     LIMIT 1"
);
$existing->bind_param('si', $tokenHash, $accountId);
$existing->execute();
$existingRow = $existing->get_result()->fetch_assoc() ?: null;
$existing->close();

if ($existingRow !== null) {
    echo "FIRST_ONBOARDING_INVITE=already_seeded\n";
    exit(0);
}

$mysqli->begin_transaction();
try {
    $revoke = $mysqli->prepare(
        "UPDATE `{$invitations}`
         SET revoked_at = NOW()
         WHERE user_account_id = ? AND used_at IS NULL AND revoked_at IS NULL"
    );
    $revoke->bind_param('i', $accountId);
    $revoke->execute();
    $revoke->close();

    $insert = $mysqli->prepare(
        "INSERT INTO `{$invitations}`
            (user_account_id, member_id, token_hash, created_by_user_account_id, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 14 DAY))"
    );
    $insert->bind_param('iisi', $accountId, $memberId, $tokenHash, $accountId);
    $insert->execute();
    $insert->close();

    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    throw $error;
}

echo "FIRST_ONBOARDING_INVITE=seeded\n";
