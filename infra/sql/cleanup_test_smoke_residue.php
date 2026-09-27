<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$db = new mysqli(
    (string) getenv('DB_HOST'),
    (string) getenv('DB_USERNAME'),
    (string) getenv('DB_PASSWORD'),
    (string) getenv('DB_NAME'),
    (int) (getenv('DB_PORT') ?: 3306)
);
$db->set_charset('utf8mb4');

$prefix = 'bd_test_';
$schema = (string) getenv('DB_NAME');

$tableExists = static function (mysqli $db, string $schema, string $table): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.tables WHERE table_schema=? AND table_name=? LIMIT 1');
    $stmt->bind_param('ss', $schema, $table);
    $stmt->execute();
    $ok = $stmt->get_result()->fetch_row() !== null;
    $stmt->close();
    return $ok;
};

$ids = static function (mysqli $db, string $sql): array {
    $out = [];
    $res = $db->query($sql);
    while ($row = $res->fetch_row()) {
        $value = (string) ($row[0] ?? '');
        if (preg_match('/^[1-9][0-9]*$/', $value)) $out[] = $value;
    }
    return array_values(array_unique($out));
};

$list = static fn(array $values): string => implode(',', array_map(
    static fn(string $value): string => (string) (int) $value,
    $values
));

$clubTable = $prefix . 'clubs';
$clubWhere = "(slug REGEXP '^(checkin|elo|scoring|break|operations|playoff|scolia)-smoke-'"
    . " OR name REGEXP '^(Checkin|ELO|Scoring|Break|Operations|Playoff|Scolia) Smoke ')";

$clubs = $tableExists($db, $schema, $clubTable)
    ? $ids($db, "SELECT id FROM {$clubTable} WHERE {$clubWhere}")
    : [];

$entity = [
    'club' => $clubs,
    'season' => [],
    'tournament' => [],
    'player' => [],
    'kiosk' => [],
    'match' => [],
    'group' => [],
    'tournament_player' => [],
    'user_account' => [],
];

if ($clubs !== []) {
    $clubList = $list($clubs);
    foreach ([
        'season' => ['seasons', "club_id IN ({$clubList})"],
        'tournament' => ['tournaments', "club_id IN ({$clubList})"],
        'player' => ['players', "club_id IN ({$clubList})"],
        'kiosk' => ['kiosks', "club_id IN ({$clubList})"],
    ] as $key => [$suffix, $where]) {
        $table = $prefix . $suffix;
        if ($tableExists($db, $schema, $table)) {
            $entity[$key] = $ids($db, "SELECT id FROM {$table} WHERE {$where}");
        }
    }
}

if ($entity['tournament'] !== []) {
    $tournamentList = $list($entity['tournament']);
    foreach ([
        'match' => ['matches', "tournament_id IN ({$tournamentList})"],
        'group' => ['tournament_groups', "tournament_id IN ({$tournamentList})"],
        'tournament_player' => ['tournament_players', "tournament_id IN ({$tournamentList})"],
    ] as $key => [$suffix, $where]) {
        $table = $prefix . $suffix;
        if ($tableExists($db, $schema, $table)) {
            $entity[$key] = $ids($db, "SELECT id FROM {$table} WHERE {$where}");
        }
    }
}

$usersTable = $prefix . 'user_accounts';
if ($tableExists($db, $schema, $usersTable)) {
    $entity['user_account'] = $ids(
        $db,
        "SELECT id FROM {$usersTable} WHERE email LIKE 'bd-onboarding-smoke-%@example.invalid'"
    );
}

echo 'SMOKE_CLUBS_BEFORE=' . count($entity['club']) . PHP_EOL;
echo 'SMOKE_TOURNAMENTS_BEFORE=' . count($entity['tournament']) . PHP_EOL;
echo 'SMOKE_PLAYERS_BEFORE=' . count($entity['player']) . PHP_EOL;
echo 'SMOKE_KIOSKS_BEFORE=' . count($entity['kiosk']) . PHP_EOL;
echo 'SMOKE_MATCHES_BEFORE=' . count($entity['match']) . PHP_EOL;
echo 'SMOKE_LOCAL_USERS_BEFORE=' . count($entity['user_account']) . PHP_EOL;

$targets = [
    'club_id' => $entity['club'],
    'season_id' => $entity['season'],
    'tournament_id' => $entity['tournament'],
    'player_id' => $entity['player'],
    'player_a_id' => $entity['player'],
    'player_b_id' => $entity['player'],
    'winner_player_id' => $entity['player'],
    'starting_player_id' => $entity['player'],
    'kiosk_id' => $entity['kiosk'],
    'physical_kiosk_id' => $entity['kiosk'],
    'match_id' => $entity['match'],
    'group_id' => $entity['group'],
    'tournament_group_id' => $entity['group'],
    'tournament_player_id' => $entity['tournament_player'],
    'user_account_id' => $entity['user_account'],
];

$tables = [];
$stmt = $db->prepare(
    "SELECT table_name FROM information_schema.tables
      WHERE table_schema=? AND table_name LIKE 'bd_test_%'
      ORDER BY table_name"
);
$stmt->bind_param('s', $schema);
$stmt->execute();
$res = $stmt->get_result();
while ($row = $res->fetch_assoc()) $tables[] = (string) $row['table_name'];
$stmt->close();

$deleted = [];
$db->begin_transaction();
try {
    $db->query('SET FOREIGN_KEY_CHECKS=0');

    foreach ($tables as $table) {
        if ($table === $clubTable || $table === $usersTable) continue;

        $columns = [];
        $columnStmt = $db->prepare(
            'SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?'
        );
        $columnStmt->bind_param('ss', $schema, $table);
        $columnStmt->execute();
        $columnRes = $columnStmt->get_result();
        while ($row = $columnRes->fetch_assoc()) $columns[(string) $row['column_name']] = true;
        $columnStmt->close();

        $conditions = [];
        foreach ($targets as $column => $values) {
            if ($values === [] || !isset($columns[$column])) continue;
            $conditions[] = $column . ' IN (' . $list($values) . ')';
        }
        if ($conditions === []) continue;

        $db->query("DELETE FROM {$table} WHERE " . implode(' OR ', $conditions));
        if ($db->affected_rows > 0) $deleted[$table] = ($deleted[$table] ?? 0) + $db->affected_rows;
    }

    $activityTable = $prefix . 'activity_events';
    if ($tableExists($db, $schema, $activityTable)) {
        $db->query(
            "DELETE FROM {$activityTable}
              WHERE page_title='Activity smoke'
                 OR metadata_json LIKE '%\"source\":\"smoke\"%'"
        );
        if ($db->affected_rows > 0) {
            $deleted[$activityTable] = ($deleted[$activityTable] ?? 0) + $db->affected_rows;
        }
    }

    if ($entity['user_account'] !== [] && $tableExists($db, $schema, $usersTable)) {
        $db->query("DELETE FROM {$usersTable} WHERE id IN (" . $list($entity['user_account']) . ')');
        if ($db->affected_rows > 0) $deleted[$usersTable] = ($deleted[$usersTable] ?? 0) + $db->affected_rows;
    }

    if ($entity['club'] !== [] && $tableExists($db, $schema, $clubTable)) {
        $db->query("DELETE FROM {$clubTable} WHERE id IN (" . $list($entity['club']) . ')');
        if ($db->affected_rows > 0) $deleted[$clubTable] = ($deleted[$clubTable] ?? 0) + $db->affected_rows;
    }

    $db->query('SET FOREIGN_KEY_CHECKS=1');
    $db->commit();
} catch (Throwable $error) {
    $db->rollback();
    try {
        $db->query('SET FOREIGN_KEY_CHECKS=1');
    } catch (Throwable) {
    }
    throw $error;
}

ksort($deleted);
foreach ($deleted as $table => $count) {
    echo "DELETED {$table}={$count}" . PHP_EOL;
}

$remainingClubs = $tableExists($db, $schema, $clubTable)
    ? (int) ($db->query("SELECT COUNT(*) c FROM {$clubTable} WHERE {$clubWhere}")->fetch_assoc()['c'] ?? 0)
    : 0;
$remainingUsers = $tableExists($db, $schema, $usersTable)
    ? (int) ($db->query("SELECT COUNT(*) c FROM {$usersTable} WHERE email LIKE 'bd-onboarding-smoke-%@example.invalid'")->fetch_assoc()['c'] ?? 0)
    : 0;

echo "SMOKE_CLUBS_AFTER={$remainingClubs}" . PHP_EOL;
echo "SMOKE_LOCAL_USERS_AFTER={$remainingUsers}" . PHP_EOL;
echo "TEST_SMOKE_CLEANUP_OK=yes" . PHP_EOL;
