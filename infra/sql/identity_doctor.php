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

$users = '`' . $prefix . 'user_accounts`';
$profiles = '`' . $prefix . 'member_profiles`';
$players = '`' . $prefix . 'players`';
$globalRoles = '`' . $prefix . 'global_user_roles`';
$clubRoles = '`' . $prefix . 'club_user_roles`';

$one = static fn (mysqli $db, string $sql): int => (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0);

$result = [
    'users' => $one($db, "SELECT COUNT(*) c FROM {$users}"),
    'users_with_player' => $one($db, "SELECT COUNT(*) c FROM {$users} WHERE player_id IS NOT NULL"),
    'players' => $one($db, "SELECT COUNT(*) c FROM {$players}"),
    'players_with_member' => $one($db, "SELECT COUNT(*) c FROM {$players} WHERE member_id IS NOT NULL"),
    'global_super_admin_grants' => $one($db, "SELECT COUNT(*) c FROM {$globalRoles} WHERE role='super_admin'"),
    'club_admin_grants' => $one($db, "SELECT COUNT(*) c FROM {$clubRoles} WHERE role='club_admin'"),
    'broken_account_player_links' => $one($db, "SELECT COUNT(*) c FROM {$users} ua LEFT JOIN {$players} p ON p.id=ua.player_id WHERE ua.player_id IS NOT NULL AND p.id IS NULL"),
    'profile_direct_link_mismatches' => $one($db, "SELECT COUNT(*) c FROM {$profiles} mp JOIN {$users} ua ON ua.id=mp.user_account_id WHERE mp.player_id IS NOT NULL AND NOT (ua.player_id <=> mp.player_id)"),
];

$result['ready'] = $result['broken_account_player_links'] === 0
    && $result['profile_direct_link_mismatches'] === 0;

echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($result['ready'] ? 0 : 1);
