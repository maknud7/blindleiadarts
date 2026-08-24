<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { exit(2); }
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$get = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') { throw new RuntimeException('Missing env: ' . $key); }
    return $value;
};

$db = new mysqli($get('DB_HOST'), $get('DB_USERNAME'), $get('DB_PASSWORD'), $get('DB_NAME'), (int) $get('DB_PORT'));
$db->set_charset('utf8mb4');
$prefix = getenv('DB_TABLE_PREFIX') ?: 'bd_test_';
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) { throw new RuntimeException('Invalid prefix'); }

$usersName = $prefix . 'user_accounts';
$profilesName = $prefix . 'member_profiles';
$playersName = $prefix . 'players';
$globalRolesName = $prefix . 'global_user_roles';
$clubRolesName = $prefix . 'club_user_roles';

$users = '`' . $usersName . '`';
$profiles = '`' . $profilesName . '`';
$players = '`' . $playersName . '`';
$globalRoles = '`' . $globalRolesName . '`';
$clubRoles = '`' . $clubRolesName . '`';

$one = static fn (mysqli $db, string $sql): int => (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0);
$type = static function (mysqli $db, string $name): ?string {
    $stmt = $db->prepare('SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $stmt->bind_param('s', $name);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    return $row !== null ? (string) $row['TABLE_TYPE'] : null;
};
$columnExists = static function (mysqli $db, string $table, string $column): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$profileType = $type($db, $profilesName);
$result = [
    'users' => $one($db, "SELECT COUNT(*) c FROM {$users}"),
    'users_with_player' => $one($db, "SELECT COUNT(*) c FROM {$users} WHERE player_id IS NOT NULL"),
    'players' => $one($db, "SELECT COUNT(*) c FROM {$players}"),
    'players_with_member' => $one($db, "SELECT COUNT(*) c FROM {$players} WHERE member_id IS NOT NULL"),
    'global_super_admin_grants' => $one($db, "SELECT COUNT(*) c FROM {$globalRoles} WHERE role='super_admin'"),
    'club_admin_grants' => $one($db, "SELECT COUNT(*) c FROM {$clubRoles} WHERE role='club_admin'"),
    'broken_account_player_links' => $one($db, "SELECT COUNT(*) c FROM {$users} ua LEFT JOIN {$players} p ON p.id=ua.player_id WHERE ua.player_id IS NOT NULL AND p.id IS NULL"),
    'member_profiles_object_type' => $profileType,
    'member_profiles_is_physical_table' => $profileType === 'BASE TABLE',
    'member_profiles_view_rows' => $profileType === 'VIEW' ? $one($db, "SELECT COUNT(*) c FROM {$profiles}") : null,
    'user_contact_phone_column' => $columnExists($db, $usersName, 'contact_phone'),
    'user_profile_notes_column' => $columnExists($db, $usersName, 'profile_notes'),
];

$result['ready'] = $result['broken_account_player_links'] === 0
    && $result['member_profiles_object_type'] === 'VIEW'
    && $result['member_profiles_is_physical_table'] === false
    && $result['member_profiles_view_rows'] === $result['users']
    && $result['user_contact_phone_column'] === true
    && $result['user_profile_notes_column'] === true;

echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($result['ready'] ? 0 : 1);
