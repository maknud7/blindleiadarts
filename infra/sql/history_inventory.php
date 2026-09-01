<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') throw new RuntimeException("Missing {$key}");
    return $value;
};

$db = mysqli_init();
if ($db === false) throw new RuntimeException('Could not initialize mysqli.');
$db->real_connect(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$p = $required('DB_TABLE_PREFIX');

$exists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $ok = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 1;
    $stmt->close();
    return $ok;
};

$columns = static function (mysqli $db, string $table): array {
    $stmt = $db->prepare('SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    return array_map(static fn (array $row): string => (string) $row['column_name'], $rows);
};

$selectExisting = static function (array $available, array $wanted, string $alias = ''): array {
    $result = [];
    foreach ($wanted as $name) {
        if (in_array($name, $available, true)) {
            $result[] = ($alias !== '' ? $alias . '.' : '') . '`' . $name . '`';
        }
    }
    return $result;
};

$printRows = static function (string $label, mysqli_result $result): void {
    echo "\n=== {$label} ===\n";
    foreach ($result->fetch_all(MYSQLI_ASSOC) as $row) {
        echo json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }
};

$seasonTable = $p . 'seasons';
if ($exists($db, $seasonTable)) {
    $seasonCols = $columns($db, $seasonTable);
    echo 'SEASON_COLUMNS ' . implode(',', $seasonCols) . "\n";
    $select = $selectExisting($seasonCols, ['id','club_id','name','starts_on','ends_on','is_active','status','ranking_method','points_win','points_draw','points_loss','created_at','updated_at']);
    $order = in_array('starts_on', $seasonCols, true) ? '`starts_on` DESC,`id` DESC' : '`id` DESC';
    $printRows('seasons', $db->query('SELECT ' . implode(',', $select) . " FROM `{$seasonTable}` ORDER BY {$order} LIMIT 15"));
}

$tournamentTable = $p . 'tournaments';
if ($exists($db, $tournamentTable)) {
    $tournamentCols = $columns($db, $tournamentTable);
    echo 'TOURNAMENT_COLUMNS ' . implode(',', $tournamentCols) . "\n";
    $select = $selectExisting($tournamentCols, ['id','club_id','season_id','name','slug','provider_system','status','start_at','end_at','created_at','updated_at'], 't');
    $joins = [];
    $group = $select;
    if ($exists($db, $p . 'matches')) {
        $joins[] = sprintf('LEFT JOIN `%1$smatches` m ON m.tournament_id=t.id', $p);
        $select[] = 'COUNT(DISTINCT m.id) AS matches';
        if ($exists($db, $p . 'legs')) {
            $joins[] = sprintf('LEFT JOIN `%1$slegs` l ON l.match_id=m.id', $p);
            $select[] = 'COUNT(DISTINCT l.id) AS legs';
        }
        if ($exists($db, $p . 'visits')) {
            $joins[] = sprintf('LEFT JOIN `%1$svisits` v ON v.match_id=m.id', $p);
            $select[] = 'COUNT(DISTINCT v.id) AS visits';
        }
    }
    $order = in_array('start_at', $tournamentCols, true) ? 't.`start_at` DESC,t.`id` DESC' : 't.`id` DESC';
    $sql = 'SELECT ' . implode(',', $select) . " FROM `{$tournamentTable}` t " . implode(' ', $joins);
    if ($joins !== []) $sql .= ' GROUP BY ' . implode(',', $group);
    $sql .= " ORDER BY {$order} LIMIT 50";
    $printRows('tournaments', $db->query($sql));
}

if ($exists($db, $p . 'external_references')) {
    $externalTable = $p . 'external_references';
    $externalCols = $columns($db, $externalTable);
    echo 'EXTERNAL_REFERENCE_COLUMNS ' . implode(',', $externalCols) . "\n";
    $provider = 'darts' . 'atlas';
    if (in_array('external_system', $externalCols, true)) {
        $stmt = $db->prepare(sprintf(
            'SELECT external_system,external_entity_type,internal_entity_type,COUNT(*) refs,
                    MIN(external_id) sample_external_id,MAX(last_synced_at) last_synced_at
             FROM `%1$sexternal_references`
             WHERE external_system=? OR external_system LIKE "%%atlas%%"
             GROUP BY external_system,external_entity_type,internal_entity_type
             ORDER BY refs DESC',
            $p
        ));
        $stmt->bind_param('s', $provider);
        $stmt->execute();
        $printRows('legacy external references', $stmt->get_result());
        $stmt->close();
    }
}

if ($exists($db, $p . 'players') && $exists($db, $p . 'elo_current_ratings')) {
    $playerTable = $p . 'players';
    $eloTable = $p . 'elo_current_ratings';
    $matchTable = $p . 'matches';
    $tournamentPlayerTable = $p . 'tournament_players';
    $externalTable = $p . 'external_references';
    $accountTable = $p . 'user_accounts';

    $duplicateNames = $db->query(
        "SELECT LOWER(TRIM(p.display_name)) AS normalized_name,COUNT(*) AS rating_rows
         FROM `{$eloTable}` e
         INNER JOIN `{$playerTable}` p ON p.id=e.player_id
         WHERE p.merged_into_player_id IS NULL
         GROUP BY LOWER(TRIM(p.display_name))
         HAVING COUNT(*)>1
         ORDER BY normalized_name"
    )->fetch_all(MYSQLI_ASSOC);

    echo "\n=== elo duplicate display names ===\n";
    if ($duplicateNames === []) {
        echo "none\n";
    }

    foreach ($duplicateNames as $duplicate) {
        $normalizedName = (string) $duplicate['normalized_name'];
        $select = [
            'p.id',
            'p.club_id',
            'p.display_name',
            'p.member_id',
            'p.member_link_source',
            'p.is_active',
            'p.merged_into_player_id',
            'e.season_id',
            'e.rating',
            'e.matches_played AS elo_matches_played',
        ];
        $joins = ["INNER JOIN `{$eloTable}` e ON e.player_id=p.id"];

        if ($exists($db, $matchTable)) {
            $select[] = '(SELECT COUNT(*) FROM `' . $matchTable . '` m WHERE m.player_a_id=p.id OR m.player_b_id=p.id) AS match_count';
        }
        if ($exists($db, $tournamentPlayerTable)) {
            $select[] = '(SELECT COUNT(*) FROM `' . $tournamentPlayerTable . '` tp WHERE tp.player_id=p.id) AS tournament_count';
        }
        if ($exists($db, $externalTable)) {
            $select[] = '(SELECT COUNT(*) FROM `' . $externalTable . '` er WHERE er.internal_entity_type IN ("player","players") AND er.internal_id=p.id) AS external_ref_count';
        }
        if ($exists($db, $accountTable)) {
            $select[] = '(SELECT COUNT(*) FROM `' . $accountTable . '` ua WHERE ua.player_id=p.id) AS account_count';
        }

        $stmt = $db->prepare(
            'SELECT ' . implode(',', $select)
            . " FROM `{$playerTable}` p " . implode(' ', $joins)
            . ' WHERE LOWER(TRIM(p.display_name))=? AND p.merged_into_player_id IS NULL'
            . ' ORDER BY (p.member_id IS NOT NULL) DESC,p.is_active DESC,e.matches_played DESC,p.id'
        );
        $stmt->bind_param('s', $normalizedName);
        $stmt->execute();
        $printRows('elo duplicate: ' . $normalizedName, $stmt->get_result());
        $stmt->close();
    }

    echo 'ELO_DUPLICATE_NAMES=' . count($duplicateNames) . "\n";
}

if ($exists($db, $p . 'external_references')) {
    $provider = 'darts' . 'atlas';
    $stmt = $db->prepare(
        "SELECT er.external_id,er.internal_id,t.name,t.status,t.start_at,t.end_at
         FROM `{$p}external_references` er
         LEFT JOIN `{$p}tournaments` t ON t.id=er.internal_id AND er.internal_entity_type='tournament'
         WHERE er.external_system=? AND er.external_entity_type='tournament'
         ORDER BY t.start_at,er.external_id"
    );
    $stmt->bind_param('s', $provider);
    $stmt->execute();
    $printRows('DartsAtlas tournament references', $stmt->get_result());
    $stmt->close();
}

if ($exists($db, $p . 'connector_sync_jobs')) {
    $jobTable = $p . 'connector_sync_jobs';
    $jobCols = $columns($db, $jobTable);
    echo 'CONNECTOR_JOB_COLUMNS ' . implode(',', $jobCols) . "\n";
    if (in_array('external_system', $jobCols, true)) {
        $provider = 'darts' . 'atlas';
        $select = $selectExisting($jobCols, ['id','external_system','job_type','scope_entity_type','scope_entity_id','status','summary_json','error_message','started_at','finished_at','created_at']);
        $stmt = $db->prepare('SELECT ' . implode(',', $select) . " FROM `{$jobTable}` WHERE external_system=? OR external_system LIKE \"%atlas%\" ORDER BY id DESC LIMIT 30");
        $stmt->bind_param('s', $provider);
        $stmt->execute();
        $printRows('legacy connector jobs', $stmt->get_result());
        $stmt->close();
    }
}
