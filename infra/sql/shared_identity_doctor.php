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

$dataPrefix = $required('DB_TABLE_PREFIX');
$identityPrefix = $required('IDENTITY_TABLE_PREFIX');
foreach ([$dataPrefix, $identityPrefix] as $prefix) {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
        throw new RuntimeException('Invalid table prefix.');
    }
}

$requiredTables = [
    'medlemmer',
    $identityPrefix . 'user_accounts',
    $identityPrefix . 'auth_sessions',
    $identityPrefix . 'global_user_roles',
    $identityPrefix . 'club_user_roles',
    $identityPrefix . 'players',
    $identityPrefix . 'clubs',
    $dataPrefix . 'players',
    $dataPrefix . 'clubs',
];

foreach ($requiredTables as $table) {
    $stmt = $db->prepare(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
    );
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    if (!$exists) {
        throw new RuntimeException('Missing shared identity dependency: ' . $table);
    }
}

// Domain actor references are deliberately soft IDs. Authentication, permissions and
// onboarding remain strongly constrained inside their own identity prefix.
$localUsers = $dataPrefix . 'user_accounts';
$identityTables = [
    $dataPrefix . 'auth_sessions',
    $dataPrefix . 'club_user_roles',
    $dataPrefix . 'global_user_roles',
    $dataPrefix . 'user_onboarding_invitations',
];
$stmt = $db->prepare(
    'SELECT TABLE_NAME, CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND REFERENCED_TABLE_SCHEMA=DATABASE()
        AND REFERENCED_TABLE_NAME=?'
);
$stmt->bind_param('s', $localUsers);
$stmt->execute();
$result = $stmt->get_result();
while ($row = $result->fetch_assoc()) {
    $table = (string) $row['TABLE_NAME'];
    if (!in_array($table, $identityTables, true)) {
        throw new RuntimeException('Domain table still has a local user FK: ' . $table);
    }
}
$stmt->close();

$identityUsers = $identityPrefix . 'user_accounts';
$identityPlayers = $identityPrefix . 'players';
$identityClubRoles = $identityPrefix . 'club_user_roles';
$identityClubs = $identityPrefix . 'clubs';
$localPlayers = $dataPrefix . 'players';
$localClubs = $dataPrefix . 'clubs';

// Exercise the same cross-environment mapping shape used by UserAccountRepository,
// without modifying either environment and without emitting personal data.
$query = "SELECT
            ua.id,
            p.id AS local_player_id,
            COALESCE(ua.member_id, ip.member_id, p.member_id) AS member_id,
            (SELECT GROUP_CONCAT(lc.id ORDER BY lc.id SEPARATOR ',')
               FROM `{$identityClubRoles}` cur
               INNER JOIN `{$identityClubs}` ic ON ic.id=cur.club_id
               INNER JOIN `{$localClubs}` lc ON lc.slug=ic.slug
              WHERE cur.user_account_id=ua.id AND cur.role='club_admin') AS local_admin_club_ids
          FROM `{$identityUsers}` ua
          LEFT JOIN `{$identityPlayers}` ip ON ip.id=ua.player_id
          LEFT JOIN `{$localPlayers}` p ON p.id=(
              SELECT MIN(p2.id) FROM `{$localPlayers}` p2
               WHERE p2.member_id=COALESCE(ua.member_id, ip.member_id)
          )
         WHERE ua.account_status='active' AND ua.is_active=1
         ORDER BY ua.id
         LIMIT 1";
$db->query($query)->free();

echo "SHARED_IDENTITY_DOCTOR_OK=yes\n";
echo "DATA_PREFIX={$dataPrefix}\n";
echo "IDENTITY_PREFIX={$identityPrefix}\n";
$db->close();
