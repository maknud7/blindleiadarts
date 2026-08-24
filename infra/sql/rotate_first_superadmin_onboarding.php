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
    throw new RuntimeException('Pilot onboarding rotation is allowed only for bd_test_.');
}

$mysqli = new mysqli($host, $username, $password, $dbName, $port);
$mysqli->set_charset('utf8mb4');

$users = $prefix . 'user_accounts';
$players = $prefix . 'players';
$globalRoles = $prefix . 'global_user_roles';
$invitations = $prefix . 'user_onboarding_invitations';

$displayName = 'Magnus Knudsen';
$legacyPilotTokenHash = '34121f871419f80a5125baf67b81e61b8f7647ba3757ff0817cfe4225e32101b';

$stmt = $mysqli->prepare(
    "SELECT ua.id AS account_id,
            ua.member_id AS account_member_id,
            ua.player_id,
            ua.account_status,
            ua.is_active,
            ua.password_hash,
            p.member_id AS player_member_id
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
    throw new RuntimeException('Expected exactly one matching superadmin account.');
}

$accountId = (int) $rows[0]['account_id'];
$memberId = (int) ($rows[0]['account_member_id'] ?? 0);
$playerId = $rows[0]['player_id'] !== null ? (int) $rows[0]['player_id'] : null;
$playerMemberId = $rows[0]['player_member_id'] !== null ? (int) $rows[0]['player_member_id'] : null;
$originalPasswordHash = (string) ($rows[0]['password_hash'] ?? '');

if ($memberId <= 0) {
    throw new RuntimeException('Superadmin account is not linked to a canonical member.');
}
if ($playerId !== null && $playerMemberId !== $memberId) {
    throw new RuntimeException('Superadmin account and player do not resolve to the same member.');
}
if ((string) $rows[0]['account_status'] !== 'active' || (int) $rows[0]['is_active'] !== 1) {
    throw new RuntimeException('Pilot superadmin must remain active during onboarding.');
}
if ($originalPasswordHash === '') {
    throw new RuntimeException('Pilot superadmin must retain the existing password until onboarding completes.');
}

$memberCheck = $mysqli->prepare('SELECT id FROM `medlemmer` WHERE id = ? LIMIT 1');
$memberCheck->bind_param('i', $memberId);
$memberCheck->execute();
$memberExists = $memberCheck->get_result()->fetch_assoc() !== null;
$memberCheck->close();
if (!$memberExists) {
    throw new RuntimeException('Canonical member row does not exist.');
}

// If a fresh non-legacy invite is already live, do not rotate again. This makes
// CI retries safe without ever persisting the raw token in source control.
$current = $mysqli->prepare(
    "SELECT id, expires_at
     FROM `{$invitations}`
     WHERE user_account_id = ?
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND token_hash <> ?
     ORDER BY id DESC
     LIMIT 1"
);
$current->bind_param('is', $accountId, $legacyPilotTokenHash);
$current->execute();
$currentRow = $current->get_result()->fetch_assoc() ?: null;
$current->close();

if ($currentRow !== null) {
    echo "PILOT_ONBOARDING_INVITE=already_current\n";
    echo 'PILOT_ONBOARDING_EXPIRES_AT=' . (string) $currentRow['expires_at'] . "\n";
    exit(0);
}

$rawToken = bin2hex(random_bytes(32));
$tokenHash = hash('sha256', $rawToken);

$mysqli->begin_transaction();
try {
    $lock = $mysqli->prepare(
        "SELECT account_status, is_active, password_hash, member_id
         FROM `{$users}`
         WHERE id = ? FOR UPDATE"
    );
    $lock->bind_param('i', $accountId);
    $lock->execute();
    $locked = $lock->get_result()->fetch_assoc() ?: null;
    $lock->close();

    if ($locked === null
        || (string) $locked['account_status'] !== 'active'
        || (int) $locked['is_active'] !== 1
        || (int) ($locked['member_id'] ?? 0) !== $memberId
        || (string) ($locked['password_hash'] ?? '') !== $originalPasswordHash
    ) {
        throw new RuntimeException('Pilot account changed while preparing onboarding rotation.');
    }

    $revoke = $mysqli->prepare(
        "UPDATE `{$invitations}`
         SET revoked_at = NOW()
         WHERE user_account_id = ?
           AND used_at IS NULL
           AND revoked_at IS NULL"
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
    $inviteId = (int) $insert->insert_id;
    $insert->close();

    $verify = $mysqli->prepare(
        "SELECT ua.account_status, ua.is_active, ua.password_hash, ua.member_id,
                p.member_id AS player_member_id,
                EXISTS(
                    SELECT 1 FROM `{$globalRoles}` gur
                    WHERE gur.user_account_id = ua.id AND gur.role = 'super_admin'
                ) AS has_super_admin,
                i.expires_at
         FROM `{$users}` ua
         LEFT JOIN `{$players}` p ON p.id = ua.player_id
         INNER JOIN `{$invitations}` i ON i.id = ?
         WHERE ua.id = ?"
    );
    $verify->bind_param('ii', $inviteId, $accountId);
    $verify->execute();
    $verified = $verify->get_result()->fetch_assoc() ?: null;
    $verify->close();

    if ($verified === null
        || (string) $verified['account_status'] !== 'active'
        || (int) $verified['is_active'] !== 1
        || (string) ($verified['password_hash'] ?? '') !== $originalPasswordHash
        || (int) ($verified['member_id'] ?? 0) !== $memberId
        || ($playerId !== null && (int) ($verified['player_member_id'] ?? 0) !== $memberId)
        || (int) $verified['has_super_admin'] !== 1
    ) {
        throw new RuntimeException('Pilot invariants failed after onboarding rotation.');
    }

    $expiresAt = (string) $verified['expires_at'];
    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    throw $error;
}

// Raw token is intentionally emitted exactly once at issuance time and is never
// stored in the repository or database. Subsequent retries return already_current.
echo "PILOT_ONBOARDING_INVITE=rotated\n";
echo "PILOT_ONBOARDING_TOKEN={$rawToken}\n";
echo "PILOT_ONBOARDING_EXPIRES_AT={$expiresAt}\n";
echo "PILOT_ACCOUNT_REMAINS_ACTIVE=yes\n";
echo "PILOT_PASSWORD_RETAINED=yes\n";
echo "PILOT_SUPER_ADMIN_RETAINED=yes\n";
