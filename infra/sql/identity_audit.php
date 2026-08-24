<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit(2);
}

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException('Missing env: ' . $key);
    }
    return $value;
};

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = getenv('DB_TABLE_PREFIX') ?: 'bd_test_';

$identifier = static function (string $name): string {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) {
        throw new InvalidArgumentException('Invalid identifier');
    }
    return '`' . $name . '`';
};

$tableExists = static function (string $table) use ($db): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$count = static function (string $table, string $where = '1=1') use ($db, $identifier): int {
    return (int) ($db->query('SELECT COUNT(*) AS c FROM ' . $identifier($table) . ' WHERE ' . $where)->fetch_assoc()['c'] ?? 0);
};

$tables = [
    'members' => 'medlemmer',
    'legacy_players' => 'players',
    'players' => $prefix . 'players',
    'users' => $prefix . 'user_accounts',
    'profiles' => $prefix . 'member_profiles',
    'roles' => $prefix . 'club_user_roles',
    'matches' => $prefix . 'matches',
];

foreach ($tables as $label => $table) {
    echo 'TABLE ' . $label . ' exists=' . ($tableExists($table) ? 'yes' : 'no');
    if ($tableExists($table)) {
        echo ' rows=' . $count($table);
    }
    echo PHP_EOL;
}

if ($tableExists($tables['players']) && $tableExists($tables['members'])) {
    echo 'PLAYERS linked_member=' . $count($tables['players'], 'member_id IS NOT NULL') . PHP_EOL;
    echo 'PLAYERS unlinked_member=' . $count($tables['players'], 'member_id IS NULL') . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s p LEFT JOIN %s m ON m.id=p.member_id WHERE p.member_id IS NOT NULL AND m.id IS NULL',
        $identifier($tables['players']),
        $identifier($tables['members'])
    );
    echo 'PLAYERS broken_member_links=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s m LEFT JOIN %s p ON p.member_id=m.id WHERE p.id IS NULL',
        $identifier($tables['members']),
        $identifier($tables['players'])
    );
    echo 'MEMBERS without_player=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    // Count exact normalized name matches without printing any names. Explicit
    // collation is required because the migrated legacy table uses general_ci.
    $memberName = 'LOWER(TRIM(CONVERT(navn USING utf8mb4))) COLLATE utf8mb4_unicode_ci';
    $playerName = 'LOWER(TRIM(CONVERT(p.display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci';
    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s p JOIN (SELECT %s n, MIN(id) id, COUNT(*) cnt FROM %s GROUP BY %s) m ON m.n=%s WHERE m.cnt=1',
        $identifier($tables['players']),
        $memberName,
        $identifier($tables['members']),
        $memberName,
        $playerName
    );
    echo 'MATCHING exact_unique_player_member_names=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM (SELECT %s n FROM %s GROUP BY %s HAVING COUNT(*)>1) x',
        $memberName,
        $identifier($tables['members']),
        $memberName
    );
    echo 'MATCHING duplicate_member_name_groups=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM (SELECT LOWER(TRIM(display_name)) COLLATE utf8mb4_unicode_ci n FROM %s GROUP BY LOWER(TRIM(display_name)) COLLATE utf8mb4_unicode_ci HAVING COUNT(*)>1) x',
        $identifier($tables['players'])
    );
    echo 'MATCHING duplicate_player_name_groups=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;
}

if ($tableExists($tables['users'])) {
    echo 'USERS email_set=' . $count($tables['users'], "email IS NOT NULL AND TRIM(email)<>''") . PHP_EOL;
    echo 'USERS super_admin=' . $count($tables['users'], "role='super_admin'") . PHP_EOL;
    echo 'USERS club_admin_legacy=' . $count($tables['users'], "role='club_admin'") . PHP_EOL;
    echo 'USERS player_legacy_role=' . $count($tables['users'], "role='player'") . PHP_EOL;
}

if ($tableExists($tables['users']) && $tableExists($tables['profiles']) && $tableExists($tables['players'])) {
    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s ua LEFT JOIN %s mp ON mp.user_account_id=ua.id WHERE mp.id IS NULL',
        $identifier($tables['users']),
        $identifier($tables['profiles'])
    );
    echo 'USERS without_profile=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s mp WHERE mp.player_id IS NULL',
        $identifier($tables['profiles'])
    );
    echo 'PROFILES without_player=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s ua JOIN %s mp ON mp.user_account_id=ua.id JOIN %s p ON p.id=mp.player_id WHERE p.member_id IS NOT NULL',
        $identifier($tables['users']),
        $identifier($tables['profiles']),
        $identifier($tables['players'])
    );
    echo 'USERS linked_player_and_member=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;

    $sql = sprintf(
        'SELECT COUNT(*) AS c FROM %s ua JOIN %s mp ON mp.user_account_id=ua.id JOIN %s p ON p.id=mp.player_id WHERE p.member_id IS NULL',
        $identifier($tables['users']),
        $identifier($tables['profiles']),
        $identifier($tables['players'])
    );
    echo 'USERS linked_player_without_member=' . (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0) . PHP_EOL;
}

if ($tableExists($tables['roles'])) {
    echo 'ROLE_GRANTS club_admin=' . $count($tables['roles'], "role='club_admin'") . PHP_EOL;
}

if ($tableExists($tables['legacy_players']) && $tableExists($tables['players'])) {
    echo 'DUPLICATE_PLAYER_MODELS=yes' . PHP_EOL;
}

// Structural assessment flags. No personal values are printed.
echo 'MODEL_HAS_ACCOUNT_ROLE_COLUMN=' . ($tableExists($tables['users']) ? 'yes' : 'no') . PHP_EOL;
echo 'MODEL_HAS_ACCOUNT_PLAYER_BRIDGE=' . ($tableExists($tables['profiles']) ? 'yes' : 'no') . PHP_EOL;
echo 'MODEL_HAS_PLAYER_MEMBER_LINK=' . ($tableExists($tables['players']) ? 'yes' : 'no') . PHP_EOL;
echo 'MODEL_HAS_CENTRAL_PERSON_TABLE=' . ($tableExists($prefix . 'people') ? 'yes' : 'no') . PHP_EOL;
