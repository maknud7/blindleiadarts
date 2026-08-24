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
    "SELECT ua.id AS account_id,
            ua.member_id AS account_member_id,
            p.id AS player_id,
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
$playerId = $rows[0]['player_id'] !== null ? (int) $rows[0]['player_id'] : null;
$accountMemberId = $rows[0]['account_member_id'] !== null ? (int) $rows[0]['account_member_id'] : null;
$playerMemberId = $rows[0]['player_member_id'] !== null ? (int) $rows[0]['player_member_id'] : null;

if ($accountMemberId !== null && $playerMemberId !== null && $accountMemberId !== $playerMemberId) {
    throw new RuntimeException('Superadmin account and player point to different members.');
}

$memberId = $accountMemberId ?? $playerMemberId;
if ($memberId === null) {
    // Pilot-only recovery: exact name matching is allowed only when the canonical
    // member register contains one and only one matching row.
    $memberLookup = $mysqli->prepare(
        'SELECT id FROM `medlemmer` WHERE LOWER(TRIM(navn)) = LOWER(TRIM(?)) LIMIT 2'
    );
    $memberLookup->bind_param('s', $displayName);
    $memberLookup->execute();
    $memberResult = $memberLookup->get_result();
    $memberRows = [];
    while ($row = $memberResult->fetch_assoc()) {
        $memberRows[] = $row;
    }
    $memberLookup->close();

    if (count($memberRows) !== 1) {
        throw new RuntimeException('Could not resolve exactly one canonical member by exact name.');
    }
    $memberId = (int) $memberRows[0]['id'];
}

if ($memberId <= 0) {
    throw new RuntimeException('Resolved member id is invalid.');
}

$memberCheck = $mysqli->prepare('SELECT id FROM `medlemmer` WHERE id = ? LIMIT 1');
$memberCheck->bind_param('i', $memberId);
$memberCheck->execute();
$memberExists = $memberCheck->get_result()->fetch_assoc() !== null;
$memberCheck->close();
if (!$memberExists) {
    throw new RuntimeException('Canonical member row does not exist.');
}

$mysqli->begin_transaction();
try {
    if ($accountMemberId === null) {
        $linkAccount = $mysqli->prepare(
            "UPDATE `{$users}` SET member_id = ? WHERE id = ? AND member_id IS NULL"
        );
        $linkAccount->bind_param('ii', $memberId, $accountId);
        $linkAccount->execute();
        $linkAccount->close();
    }

    if ($playerId !== null && $playerMemberId === null) {
        $source = 'exact_name';
        $linkPlayer = $mysqli->prepare(
            "UPDATE `{$players}`
             SET member_id = ?, member_link_source = ?, member_linked_at = NOW()
             WHERE id = ? AND member_id IS NULL"
        );
        $linkPlayer->bind_param('isi', $memberId, $source, $playerId);
        $linkPlayer->execute();
        $linkPlayer->close();
    }

    // Re-read the links inside the transaction. Both account and player, when a
    // player exists, must now resolve to the same canonical member.
    $verify = $mysqli->prepare(
        "SELECT ua.member_id AS account_member_id, p.member_id AS player_member_id
         FROM `{$users}` ua
         LEFT JOIN `{$players}` p ON p.id = ua.player_id
         WHERE ua.id = ? FOR UPDATE"
    );
    $verify->bind_param('i', $accountId);
    $verify->execute();
    $verified = $verify->get_result()->fetch_assoc() ?: null;
    $verify->close();

    if ($verified === null || (int) ($verified['account_member_id'] ?? 0) !== $memberId) {
        throw new RuntimeException('Account member link was not established.');
    }
    if ($playerId !== null && (int) ($verified['player_member_id'] ?? 0) !== $memberId) {
        throw new RuntimeException('Player member link was not established.');
    }

    $existing = $mysqli->prepare(
        "SELECT id
         FROM `{$invitations}`
         WHERE token_hash = ? AND user_account_id = ?
         LIMIT 1"
    );
    $existing->bind_param('si', $tokenHash, $accountId);
    $existing->execute();
    $existingRow = $existing->get_result()->fetch_assoc() ?: null;
    $existing->close();

    if ($existingRow === null) {
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
    }

    $mysqli->commit();
} catch (Throwable $error) {
    $mysqli->rollback();
    throw $error;
}

echo $existingRow === null
    ? "FIRST_ONBOARDING_INVITE=seeded\n"
    : "FIRST_ONBOARDING_INVITE=already_seeded\n";
