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
    throw new RuntimeException('Post-onboarding pilot doctor is allowed only for bd_test_.');
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
            ua.account_status, ua.is_active, ua.claimed_at,
            p.member_id AS player_member_id,
            EXISTS(SELECT 1 FROM `{$roles}` r WHERE r.user_account_id=ua.id AND r.role='super_admin') AS has_super_admin,
            (SELECT COUNT(*) FROM `{$invites}` i WHERE i.user_account_id=ua.id AND i.used_at IS NOT NULL) AS used_invites,
            (SELECT COUNT(*) FROM `{$invites}` i WHERE i.user_account_id=ua.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()) AS open_invites,
            (SELECT COUNT(*) FROM `{$sessions}` s WHERE s.user_account_id=ua.id AND s.revoked_at IS NULL) AS active_sessions
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
$checks = [
    'account_active' => (string)$row['account_status'] === 'active' && (int)$row['is_active'] === 1,
    'email_set' => trim((string)($row['email'] ?? '')) !== '',
    'password_hash_set' => trim((string)($row['password_hash'] ?? '')) !== '',
    'claimed_at_set' => trim((string)($row['claimed_at'] ?? '')) !== '',
    'member_linked' => (int)($row['member_id'] ?? 0) > 0,
    'player_member_matches' => $row['player_id'] === null || (int)($row['player_member_id'] ?? 0) === (int)($row['member_id'] ?? 0),
    'super_admin_retained' => (int)$row['has_super_admin'] === 1,
    'invite_consumed' => (int)$row['used_invites'] >= 1,
    'no_open_invites' => (int)$row['open_invites'] === 0,
    'old_sessions_revoked' => (int)$row['active_sessions'] === 0,
];

$ok = true;
foreach ($checks as $name => $passed) {
    echo ($passed ? 'OK   ' : 'FAIL ') . $name . "\n";
    $ok = $ok && $passed;
}

echo 'POST_ONBOARDING_PILOT_OK=' . ($ok ? 'yes' : 'no') . "\n";

if (!$ok) {
    exit(1);
}
