<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException('Missing env: ' . $key);
    }
    return trim($value);
};

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = $required('DB_TABLE_PREFIX');
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    throw new RuntimeException('Invalid table prefix.');
}

$users = $prefix . 'user_accounts';
$players = $prefix . 'players';
$globalRoles = $prefix . 'global_user_roles';
$invitations = $prefix . 'user_onboarding_invitations';
$profiles = $prefix . 'member_profiles';

$failures = [];
$assert = static function (bool $condition, string $message) use (&$failures): void {
    if (!$condition) {
        $failures[] = $message;
        echo 'FAIL ' . $message . PHP_EOL;
    } else {
        echo 'OK   ' . $message . PHP_EOL;
    }
};

$tableType = static function (mysqli $db, string $name): ?string {
    $stmt = $db->prepare(
        'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
    );
    $stmt->bind_param('s', $name);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    return $row !== null ? (string) $row['TABLE_TYPE'] : null;
};

$column = static function (mysqli $db, string $table, string $name): ?array {
    $stmt = $db->prepare(
        'SELECT IS_NULLABLE, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
    );
    $stmt->bind_param('ss', $table, $name);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    return $row;
};

$assert($tableType($db, $users) === 'BASE TABLE', 'user_accounts is a base table');
$assert($tableType($db, $invitations) === 'BASE TABLE', 'onboarding invitation table exists');
$assert($tableType($db, $profiles) === 'VIEW', 'member_profiles remains compatibility view only');
$assert($column($db, $users, 'member_id') !== null, 'user_accounts.member_id exists');
$assert($column($db, $users, 'account_status') !== null, 'user_accounts.account_status exists');
$passwordColumn = $column($db, $users, 'password_hash');
$assert($passwordColumn !== null && ($passwordColumn['IS_NULLABLE'] ?? '') === 'YES', 'password_hash is nullable before claim');

$unclaimedWithPassword = (int) ($db->query(
    "SELECT COUNT(*) c FROM `{$users}` WHERE account_status='unclaimed' AND password_hash IS NOT NULL"
)->fetch_assoc()['c'] ?? 0);
$assert($unclaimedWithPassword === 0, 'unclaimed accounts have no password');

$unclaimedActive = (int) ($db->query(
    "SELECT COUNT(*) c FROM `{$users}` WHERE account_status='unclaimed' AND is_active<>0"
)->fetch_assoc()['c'] ?? 0);
$assert($unclaimedActive === 0, 'unclaimed accounts are inactive');

$activeWithoutPassword = (int) ($db->query(
    "SELECT COUNT(*) c FROM `{$users}` WHERE account_status='active' AND is_active=1 AND password_hash IS NULL"
)->fetch_assoc()['c'] ?? 0);
$assert($activeWithoutPassword === 0, 'active accounts have a password');

$brokenSuperadmins = (int) ($db->query(
    "SELECT COUNT(*) c
     FROM `{$globalRoles}` gr
     INNER JOIN `{$users}` ua ON ua.id=gr.user_account_id
     WHERE gr.role='super_admin'
       AND (ua.account_status<>'active' OR ua.is_active<>1 OR ua.password_hash IS NULL)"
)->fetch_assoc()['c'] ?? 0);
$assert($brokenSuperadmins === 0, 'superadmin accounts remain active and claim-ready');

$duplicateMembers = (int) ($db->query(
    "SELECT COUNT(*) c FROM (
         SELECT member_id FROM `{$users}` WHERE member_id IS NOT NULL GROUP BY member_id HAVING COUNT(*)>1
     ) x"
)->fetch_assoc()['c'] ?? 0);
$assert($duplicateMembers === 0, 'one membership maps to at most one user account');

$orphanMembers = (int) ($db->query(
    "SELECT COUNT(*) c
     FROM `{$users}` ua
     LEFT JOIN `medlemmer` m ON m.id=ua.member_id
     WHERE ua.member_id IS NOT NULL AND m.id IS NULL"
)->fetch_assoc()['c'] ?? 0);
$assert($orphanMembers === 0, 'account member links resolve to canonical medlemmer');

$identityMismatch = (int) ($db->query(
    "SELECT COUNT(*) c
     FROM `{$users}` ua
     INNER JOIN `{$players}` p ON p.id=ua.player_id
     WHERE ua.member_id IS NOT NULL
       AND p.member_id IS NOT NULL
       AND ua.member_id<>p.member_id"
)->fetch_assoc()['c'] ?? 0);
$assert($identityMismatch === 0, 'account and player agree on membership identity');

$counts = $db->query(
    "SELECT
        COUNT(*) total,
        SUM(account_status='unclaimed') unclaimed,
        SUM(account_status='invited') invited,
        SUM(account_status='active') active,
        SUM(account_status='disabled') disabled,
        SUM(member_id IS NOT NULL) member_linked
     FROM `{$users}`"
)->fetch_assoc();

echo sprintf(
    "ACCOUNT_COUNTS total=%d unclaimed=%d invited=%d active=%d disabled=%d member_linked=%d\n",
    (int) ($counts['total'] ?? 0),
    (int) ($counts['unclaimed'] ?? 0),
    (int) ($counts['invited'] ?? 0),
    (int) ($counts['active'] ?? 0),
    (int) ($counts['disabled'] ?? 0),
    (int) ($counts['member_linked'] ?? 0),
);

// Temporary metadata-only probe used while consolidating member/player UX.
echo "MEMBER_SCHEMA_PROBE_BEGIN\n";
$memberColumns = $db->query(
    "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='medlemmer' ORDER BY ORDINAL_POSITION"
);
while ($row = $memberColumns->fetch_assoc()) {
    echo 'medlemmer.' . $row['COLUMN_NAME'] . ':' . $row['DATA_TYPE'] . "\n";
}
$relatedTables = $db->query(
    "SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND (LOWER(TABLE_NAME) REGEXP 'kontingent|betaling|payment|medlem'
          OR LOWER(COLUMN_NAME) REGEXP 'kontingent|betalt|betaling|payment|paid|medlem_id|maaned')
      ORDER BY TABLE_NAME"
);
while ($table = $relatedTables->fetch_assoc()) {
    $name = (string) $table['TABLE_NAME'];
    echo 'RELATED_TABLE=' . $name . "\n";
    $stmt = $db->prepare('SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION');
    $stmt->bind_param('s', $name);
    $stmt->execute();
    $columns = $stmt->get_result();
    while ($row = $columns->fetch_assoc()) {
        echo '  ' . $row['COLUMN_NAME'] . ':' . $row['DATA_TYPE'] . "\n";
    }
    $stmt->close();
}
echo "MEMBER_SCHEMA_PROBE_END\n";

if ($failures !== []) {
    throw new RuntimeException('Onboarding doctor failed with ' . count($failures) . ' issue(s).');
}

echo "ONBOARDING_DOCTOR_OK=yes\n";
$db->close();
