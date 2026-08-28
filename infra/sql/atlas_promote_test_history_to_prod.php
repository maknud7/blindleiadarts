<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException("Missing {$key}");
    }
    return trim($value);
};

if (PHP_SAPI !== 'cli') {
    throw new RuntimeException('CLI only.');
}
if ($required('ALLOW_PROD_ATLAS_PROMOTION') !== 'yes') {
    throw new RuntimeException('Refusing PROD Atlas promotion without ALLOW_PROD_ATLAS_PROMOTION=yes');
}

$manifestPath = $argv[1] ?? '';
if ($manifestPath === '' || !is_file($manifestPath)) {
    throw new RuntimeException('Usage: php atlas_promote_test_history_to_prod.php <promotion-manifest.json>');
}
$manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($manifest)) {
    throw new RuntimeException('Invalid promotion manifest.');
}

$sourcePrefix = (string) ($manifest['source_prefix'] ?? '');
$targetPrefix = (string) ($manifest['target_prefix'] ?? '');
$clubSlug = (string) ($manifest['club_slug'] ?? '');
$seasonExternalId = (string) ($manifest['season_external_id'] ?? '');
$tournamentSpecs = is_array($manifest['tournaments'] ?? null) ? $manifest['tournaments'] : [];
$expectedTotals = is_array($manifest['expected_totals'] ?? null) ? $manifest['expected_totals'] : [];

if ($sourcePrefix !== 'bd_test_' || $targetPrefix !== 'bd_prod_' || $clubSlug !== 'blindleia-dartklubb') {
    throw new RuntimeException('Promotion manifest must be bd_test_ -> bd_prod_ for Blindleia Dartklubb.');
}
if ($seasonExternalId === '' || count($tournamentSpecs) !== 3) {
    throw new RuntimeException('Promotion manifest must contain the frozen season and exactly three tournaments.');
}
if (($required('DB_TABLE_PREFIX')) !== $targetPrefix) {
    throw new RuntimeException('DB_TABLE_PREFIX must be bd_prod_ for promotion.');
}

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$ident = static function (string $name): string {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) {
        throw new RuntimeException("Unsafe SQL identifier: {$name}");
    }
    return '`' . $name . '`';
};

$tableExists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $ok = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $ok;
};

$fetchById = static function (mysqli $db, string $table, int $id) use ($ident): array {
    $stmt = $db->prepare('SELECT * FROM ' . $ident($table) . ' WHERE id=? LIMIT 1');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($row === null) {
        throw new RuntimeException("Missing row {$table}.id={$id}");
    }
    return $row;
};

$insertRow = static function (mysqli $db, string $table, array $row) use ($ident): int {
    unset($row['id']);
    if ($row === []) {
        throw new RuntimeException("Cannot insert empty row into {$table}");
    }
    foreach (array_keys($row) as $column) {
        $ident((string) $column);
    }
    $columns = array_keys($row);
    $sql = 'INSERT INTO ' . $ident($table)
        . ' (' . implode(',', array_map($ident, $columns)) . ') VALUES ('
        . implode(',', array_fill(0, count($columns), '?')) . ')';
    $stmt = $db->prepare($sql);
    $stmt->execute(array_values($row));
    $id = (int) $stmt->insert_id;
    $stmt->close();
    return $id;
};

$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

$getRef = static function (mysqli $db, string $prefix, string $type, string $externalId): ?array {
    $stmt = $db->prepare(
        "SELECT * FROM `{$prefix}external_references`
          WHERE external_system='dartsatlas' AND external_entity_type=? AND external_id=? LIMIT 1"
    );
    $stmt->bind_param('ss', $type, $externalId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    return $row;
};

$putRef = static function (mysqli $db, string $prefix, string $type, string $externalId, string $internalType, int $internalId): void {
    $stmt = $db->prepare(
        "INSERT INTO `{$prefix}external_references`
         (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at)
         VALUES ('dartsatlas',?,?,?,?, 'synced', NOW())
         ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state='synced',last_synced_at=NOW()"
    );
    $stmt->bind_param('sssi', $type, $externalId, $internalType, $internalId);
    $stmt->execute();
    $stmt->close();
};

$countForTournament = static function (mysqli $db, string $prefix, int $tournamentId): array {
    $players = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}tournament_players` WHERE tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    $matches = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    $legs = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}legs` l JOIN `{$prefix}matches` m ON m.id=l.match_id WHERE m.tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    $visits = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}visits` v JOIN `{$prefix}matches` m ON m.id=v.match_id WHERE m.tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    return compact('players', 'matches', 'legs', 'visits');
};

foreach ([
    'clubs','seasons','players','tournaments','tournament_players','tournament_groups','tournament_group_players',
    'matches','match_statistics','legs','visits','tournament_playoffs','tournament_playoff_entries',
    'tournament_playoff_nodes','season_ranking_events','external_references'
] as $suffix) {
    foreach ([$sourcePrefix, $targetPrefix] as $prefix) {
        if (!$tableExists($db, $prefix . $suffix)) {
            throw new RuntimeException("Required table is missing: {$prefix}{$suffix}");
        }
    }
}

$sourceClub = $db->query("SELECT * FROM `{$sourcePrefix}clubs` WHERE slug='" . $db->real_escape_string($clubSlug) . "' LIMIT 1")->fetch_assoc() ?: null;
$targetClub = $db->query("SELECT * FROM `{$targetPrefix}clubs` WHERE slug='" . $db->real_escape_string($clubSlug) . "' LIMIT 1")->fetch_assoc() ?: null;
if ($sourceClub === null || $targetClub === null) {
    throw new RuntimeException('Blindleia club must exist in both TEST and PROD.');
}
$sourceClubId = (int) $sourceClub['id'];
$targetClubId = (int) $targetClub['id'];

$activeProdTournaments = (int) ($db->query("SELECT COUNT(*) c FROM `{$targetPrefix}tournaments` WHERE status IN ('ready','in_progress')")->fetch_assoc()['c'] ?? 0);
$activeProdMatches = (int) ($db->query("SELECT COUNT(*) c FROM `{$targetPrefix}matches` WHERE status IN ('pending','assigned','in_progress')")->fetch_assoc()['c'] ?? 0);
if ($activeProdTournaments !== 0 || $activeProdMatches !== 0) {
    throw new RuntimeException("Refusing history promotion while PROD has active runtime: tournaments={$activeProdTournaments}, matches={$activeProdMatches}");
}

$sourceSeasonRef = $getRef($db, $sourcePrefix, 'season', $seasonExternalId);
if ($sourceSeasonRef === null) {
    throw new RuntimeException("Frozen TEST season reference {$seasonExternalId} is missing.");
}
$sourceSeasonId = (int) $sourceSeasonRef['internal_id'];
$sourceSeason = $fetchById($db, $sourcePrefix . 'seasons', $sourceSeasonId);

$sourceTournamentIds = [];
$sourceTournamentRows = [];
$sourceSpecByExternal = [];
$totalMatches = 0;
$totalLegs = 0;
$totalVisits = 0;
foreach ($tournamentSpecs as $spec) {
    if (!is_array($spec)) throw new RuntimeException('Invalid tournament spec.');
    $externalId = (string) ($spec['external_id'] ?? '');
    if ($externalId === '') throw new RuntimeException('Tournament external ID is missing.');
    $ref = $getRef($db, $sourcePrefix, 'tournament', $externalId);
    if ($ref === null) throw new RuntimeException("TEST tournament reference {$externalId} is missing.");
    $sourceId = (int) $ref['internal_id'];
    $row = $fetchById($db, $sourcePrefix . 'tournaments', $sourceId);
    if ((string) $row['status'] !== 'completed' || empty($row['end_at'])) {
        throw new RuntimeException("TEST tournament {$externalId} is not canonically completed.");
    }
    if ((string) ($row['name'] ?? '') !== (string) ($spec['name'] ?? '')) {
        throw new RuntimeException("TEST tournament name drift for {$externalId}");
    }
    $counts = $countForTournament($db, $sourcePrefix, $sourceId);
    foreach (['players','matches','legs','visits'] as $key) {
        $expectedKey = 'expected_' . $key;
        if ($counts[$key] !== (int) ($spec[$expectedKey] ?? -1)) {
            throw new RuntimeException("TEST {$externalId} {$key} drift: {$counts[$key]} vs " . ($spec[$expectedKey] ?? 'missing'));
        }
    }
    if ($getRef($db, $targetPrefix, 'tournament', $externalId) !== null) {
        throw new RuntimeException("PROD already contains tournament reference {$externalId}; refusing non-clean promotion.");
    }
    $sourceTournamentIds[$externalId] = $sourceId;
    $sourceTournamentRows[$externalId] = $row;
    $sourceSpecByExternal[$externalId] = $spec;
    $totalMatches += $counts['matches'];
    $totalLegs += $counts['legs'];
    $totalVisits += $counts['visits'];
}
if ($totalMatches !== (int) ($expectedTotals['matches'] ?? -1)
    || $totalLegs !== (int) ($expectedTotals['legs'] ?? -1)
    || $totalVisits !== (int) ($expectedTotals['visits'] ?? -1)) {
    throw new RuntimeException('Frozen TEST aggregate counts differ from promotion manifest.');
}

$sourceTournamentIdList = implode(',', array_map('intval', array_values($sourceTournamentIds)));
$participantRows = $db->query(
    "SELECT DISTINCT p.* FROM `{$sourcePrefix}players` p
     INNER JOIN `{$sourcePrefix}tournament_players` tp ON tp.player_id=p.id
     WHERE tp.tournament_id IN ({$sourceTournamentIdList}) ORDER BY p.id"
)->fetch_all(MYSQLI_ASSOC);
$participantSourceIds = array_map(static fn (array $row): int => (int) $row['id'], $participantRows);
if ($participantSourceIds === []) throw new RuntimeException('No TEST participants found for promotion.');
$participantIdList = implode(',', $participantSourceIds);
$playerRefRows = $db->query(
    "SELECT * FROM `{$sourcePrefix}external_references`
     WHERE external_system='dartsatlas' AND external_entity_type='player'
       AND internal_entity_type='player' AND internal_id IN ({$participantIdList})
     ORDER BY external_id"
)->fetch_all(MYSQLI_ASSOC);
if (count($playerRefRows) !== (int) ($expectedTotals['atlas_player_references'] ?? -1)) {
    throw new RuntimeException('TEST Atlas player reference count differs from frozen promotion manifest.');
}
$refsBySourcePlayer = [];
foreach ($playerRefRows as $ref) $refsBySourcePlayer[(int) $ref['internal_id']][] = (string) $ref['external_id'];
foreach ($participantSourceIds as $sourcePlayerId) {
    if (($refsBySourcePlayer[$sourcePlayerId] ?? []) === []) {
        throw new RuntimeException("TEST participant {$sourcePlayerId} has no DartsAtlas player reference.");
    }
}

if ($getRef($db, $targetPrefix, 'season', $seasonExternalId) !== null) {
    throw new RuntimeException("PROD already contains season reference {$seasonExternalId}; refusing non-clean promotion.");
}

echo "ATLAS_PROD_PROMOTION_PREFLIGHT_OK=yes" . PHP_EOL;
echo "ATLAS_PROD_PROMOTION_SOURCE_TOURNAMENTS=" . count($sourceTournamentIds) . PHP_EOL;
echo "ATLAS_PROD_PROMOTION_SOURCE_MATCHES={$totalMatches}" . PHP_EOL;
echo "ATLAS_PROD_PROMOTION_SOURCE_LEGS={$totalLegs}" . PHP_EOL;
echo "ATLAS_PROD_PROMOTION_SOURCE_VISITS={$totalVisits}" . PHP_EOL;
echo "ATLAS_PROD_PROMOTION_SOURCE_PLAYER_REFS=" . count($playerRefRows) . PHP_EOL;

$db->begin_transaction();
try {
    $seasonRow = $sourceSeason;
    unset($seasonRow['id']);
    $seasonRow['club_id'] = $targetClubId;
    if (array_key_exists('champion_player_id', $seasonRow)) $seasonRow['champion_player_id'] = null;
    $targetSeasonId = $insertRow($db, $targetPrefix . 'seasons', $seasonRow);
    $putRef($db, $targetPrefix, 'season', $seasonExternalId, 'season', $targetSeasonId);

    $targetPlayers = $db->query(
        "SELECT * FROM `{$targetPrefix}players` WHERE club_id={$targetClubId} OR club_id IS NULL ORDER BY id"
    )->fetch_all(MYSQLI_ASSOC);
    $targetByMember = [];
    $targetByName = [];
    foreach ($targetPlayers as $targetPlayer) {
        $memberId = $targetPlayer['member_id'] ?? null;
        if ($memberId !== null && (int) $memberId > 0) $targetByMember[(int) $memberId] = $targetPlayer;
        $targetByName[$normalise((string) $targetPlayer['display_name'])][] = $targetPlayer;
    }

    $playerMap = [];
    $createdPlayers = 0;
    $reusedPlayers = 0;
    foreach ($participantRows as $sourcePlayer) {
        $sourcePlayerId = (int) $sourcePlayer['id'];
        $candidate = null;

        // Existing PROD DartsAtlas reference is the strongest identity signal.
        foreach ($refsBySourcePlayer[$sourcePlayerId] as $externalPlayerId) {
            $existingRef = $getRef($db, $targetPrefix, 'player', $externalPlayerId);
            if ($existingRef !== null) {
                $candidate = $fetchById($db, $targetPrefix . 'players', (int) $existingRef['internal_id']);
                break;
            }
        }

        $sourceMemberId = isset($sourcePlayer['member_id']) && $sourcePlayer['member_id'] !== null ? (int) $sourcePlayer['member_id'] : null;
        if ($candidate === null && $sourceMemberId !== null && $sourceMemberId > 0 && isset($targetByMember[$sourceMemberId])) {
            $candidate = $targetByMember[$sourceMemberId];
        }
        if ($candidate === null) {
            $nameKey = $normalise((string) $sourcePlayer['display_name']);
            $candidates = $targetByName[$nameKey] ?? [];
            if ($candidates !== []) {
                usort($candidates, static function (array $a, array $b): int {
                    $linked = (($b['member_id'] ?? null) !== null ? 1 : 0) <=> (($a['member_id'] ?? null) !== null ? 1 : 0);
                    if ($linked !== 0) return $linked;
                    $active = (int) ($b['is_active'] ?? 0) <=> (int) ($a['is_active'] ?? 0);
                    return $active !== 0 ? $active : ((int) $a['id'] <=> (int) $b['id']);
                });
                $candidate = $candidates[0];
            }
        }

        if ($candidate === null) {
            $row = $sourcePlayer;
            unset($row['id']);
            $row['club_id'] = $targetClubId;
            if (array_key_exists('merged_into_player_id', $row)) $row['merged_into_player_id'] = null;
            if (array_key_exists('merged_at', $row)) $row['merged_at'] = null;
            $targetPlayerId = $insertRow($db, $targetPrefix . 'players', $row);
            $candidate = $fetchById($db, $targetPrefix . 'players', $targetPlayerId);
            $targetByName[$normalise((string) $candidate['display_name'])][] = $candidate;
            if (($candidate['member_id'] ?? null) !== null) $targetByMember[(int) $candidate['member_id']] = $candidate;
            $createdPlayers++;
        } else {
            $targetPlayerId = (int) $candidate['id'];
            $reusedPlayers++;
        }
        $playerMap[$sourcePlayerId] = $targetPlayerId;
        foreach ($refsBySourcePlayer[$sourcePlayerId] as $externalPlayerId) {
            $putRef($db, $targetPrefix, 'player', $externalPlayerId, 'player', $targetPlayerId);
        }
    }

    $targetTournamentIds = [];
    $tournamentEvidence = [];
    foreach ($sourceTournamentIds as $externalId => $sourceTournamentId) {
        $sourceTournament = $sourceTournamentRows[$externalId];
        $row = $sourceTournament;
        unset($row['id']);
        $row['club_id'] = $targetClubId;
        $row['season_id'] = $targetSeasonId;
        $row['status'] = 'in_progress';
        $row['end_at'] = null;
        $targetTournamentId = $insertRow($db, $targetPrefix . 'tournaments', $row);
        $targetTournamentIds[$externalId] = $targetTournamentId;
        $putRef($db, $targetPrefix, 'tournament', $externalId, 'tournament', $targetTournamentId);

        $tournamentPlayerMap = [];
        $sourceTournamentPlayers = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_players` WHERE tournament_id={$sourceTournamentId} ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceTournamentPlayers as $sourceTp) {
            $row = $sourceTp;
            $sourceTpId = (int) $row['id'];
            $sourcePlayerId = (int) $row['player_id'];
            unset($row['id']);
            $row['tournament_id'] = $targetTournamentId;
            $row['player_id'] = $playerMap[$sourcePlayerId] ?? throw new RuntimeException("Missing player map {$sourcePlayerId}");
            $row['status'] = 'checked_in';
            if (array_key_exists('registration_source', $row)) $row['registration_source'] = 'legacy';
            if (array_key_exists('checkin_source', $row)) $row['checkin_source'] = 'legacy';
            $targetTpId = $insertRow($db, $targetPrefix . 'tournament_players', $row);
            $tournamentPlayerMap[$sourceTpId] = $targetTpId;
        }

        $groupMap = [];
        $sourceGroups = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_groups` WHERE tournament_id={$sourceTournamentId} ORDER BY sort_order,id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceGroups as $sourceGroup) {
            $row = $sourceGroup;
            $sourceGroupId = (int) $row['id'];
            unset($row['id']);
            $row['tournament_id'] = $targetTournamentId;
            $targetGroupId = $insertRow($db, $targetPrefix . 'tournament_groups', $row);
            $groupMap[$sourceGroupId] = $targetGroupId;
        }
        if ($groupMap === []) throw new RuntimeException("No groups copied for {$externalId}");

        $sourceGroupIds = implode(',', array_map('intval', array_keys($groupMap)));
        $sourceGroupPlayers = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_group_players` WHERE group_id IN ({$sourceGroupIds}) ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceGroupPlayers as $sourceGp) {
            $row = $sourceGp;
            unset($row['id']);
            $row['group_id'] = $groupMap[(int) $sourceGp['group_id']] ?? throw new RuntimeException('Missing group map.');
            $row['tournament_player_id'] = $tournamentPlayerMap[(int) $sourceGp['tournament_player_id']] ?? throw new RuntimeException('Missing tournament-player map.');
            $insertRow($db, $targetPrefix . 'tournament_group_players', $row);
        }

        $sourceMatchRefs = $db->query(
            "SELECT er.external_id,er.internal_id FROM `{$sourcePrefix}external_references` er
             INNER JOIN `{$sourcePrefix}matches` m ON m.id=er.internal_id
             WHERE er.external_system='dartsatlas' AND er.external_entity_type='match'
               AND er.internal_entity_type='match' AND m.tournament_id={$sourceTournamentId}"
        )->fetch_all(MYSQLI_ASSOC);
        $matchExternalBySourceId = [];
        foreach ($sourceMatchRefs as $ref) $matchExternalBySourceId[(int) $ref['internal_id']] = (string) $ref['external_id'];

        $matchMap = [];
        $sourceMatches = $db->query(
            "SELECT * FROM `{$sourcePrefix}matches` WHERE tournament_id={$sourceTournamentId} ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceMatches as $sourceMatch) {
            $row = $sourceMatch;
            $sourceMatchId = (int) $row['id'];
            unset($row['id']);
            $row['tournament_id'] = $targetTournamentId;
            $row['tournament_group_id'] = $sourceMatch['tournament_group_id'] !== null
                ? ($groupMap[(int) $sourceMatch['tournament_group_id']] ?? throw new RuntimeException('Missing match group map.'))
                : null;
            $row['player_a_id'] = $playerMap[(int) $sourceMatch['player_a_id']] ?? throw new RuntimeException('Missing player A map.');
            $row['player_b_id'] = $playerMap[(int) $sourceMatch['player_b_id']] ?? throw new RuntimeException('Missing player B map.');
            $row['winner_player_id'] = $sourceMatch['winner_player_id'] !== null
                ? ($playerMap[(int) $sourceMatch['winner_player_id']] ?? throw new RuntimeException('Missing winner map.'))
                : null;
            if (array_key_exists('kiosk_id', $row)) $row['kiosk_id'] = null;
            foreach (['assigned_at','called_at','call_expires_at'] as $runtimeColumn) {
                if (array_key_exists($runtimeColumn, $row)) $row[$runtimeColumn] = null;
            }
            $targetMatchId = $insertRow($db, $targetPrefix . 'matches', $row);
            $matchMap[$sourceMatchId] = $targetMatchId;
            $externalMatchId = $matchExternalBySourceId[$sourceMatchId] ?? null;
            if ($externalMatchId === null) throw new RuntimeException("Missing DartsAtlas match reference for source match {$sourceMatchId}");
            $putRef($db, $targetPrefix, 'match', $externalMatchId, 'match', $targetMatchId);
        }

        $sourceMatchIds = implode(',', array_map('intval', array_keys($matchMap)));
        $sourceStats = $db->query(
            "SELECT * FROM `{$sourcePrefix}match_statistics` WHERE match_id IN ({$sourceMatchIds}) ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceStats as $sourceStat) {
            $row = $sourceStat;
            unset($row['id']);
            $row['match_id'] = $matchMap[(int) $sourceStat['match_id']] ?? throw new RuntimeException('Missing stats match map.');
            $row['player_id'] = $playerMap[(int) $sourceStat['player_id']] ?? throw new RuntimeException('Missing stats player map.');
            $insertRow($db, $targetPrefix . 'match_statistics', $row);
        }

        $legMap = [];
        $sourceLegs = $db->query(
            "SELECT l.* FROM `{$sourcePrefix}legs` l
             INNER JOIN `{$sourcePrefix}matches` m ON m.id=l.match_id
             WHERE m.tournament_id={$sourceTournamentId} ORDER BY l.id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceLegs as $sourceLeg) {
            $row = $sourceLeg;
            $sourceLegId = (int) $row['id'];
            unset($row['id']);
            $row['match_id'] = $matchMap[(int) $sourceLeg['match_id']] ?? throw new RuntimeException('Missing leg match map.');
            $row['starting_player_id'] = $sourceLeg['starting_player_id'] !== null
                ? ($playerMap[(int) $sourceLeg['starting_player_id']] ?? throw new RuntimeException('Missing leg starter map.'))
                : null;
            $row['winner_player_id'] = $sourceLeg['winner_player_id'] !== null
                ? ($playerMap[(int) $sourceLeg['winner_player_id']] ?? throw new RuntimeException('Missing leg winner map.'))
                : null;
            $targetLegId = $insertRow($db, $targetPrefix . 'legs', $row);
            $legMap[$sourceLegId] = $targetLegId;
        }

        $sourceVisits = $db->query(
            "SELECT v.* FROM `{$sourcePrefix}visits` v
             INNER JOIN `{$sourcePrefix}matches` m ON m.id=v.match_id
             WHERE m.tournament_id={$sourceTournamentId} ORDER BY v.id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceVisits as $sourceVisit) {
            $row = $sourceVisit;
            unset($row['id']);
            $row['match_id'] = $matchMap[(int) $sourceVisit['match_id']] ?? throw new RuntimeException('Missing visit match map.');
            $row['leg_id'] = $legMap[(int) $sourceVisit['leg_id']] ?? throw new RuntimeException('Missing visit leg map.');
            $row['player_id'] = $playerMap[(int) $sourceVisit['player_id']] ?? throw new RuntimeException('Missing visit player map.');
            if (array_key_exists('request_key', $row)) $row['request_key'] = null;
            $insertRow($db, $targetPrefix . 'visits', $row);
        }

        $sourcePlayoff = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_playoffs` WHERE tournament_id={$sourceTournamentId} LIMIT 1"
        )->fetch_assoc() ?: null;
        if ($sourcePlayoff === null) throw new RuntimeException("Missing TEST playoff for {$externalId}");
        $row = $sourcePlayoff;
        $sourcePlayoffId = (int) $row['id'];
        unset($row['id']);
        $row['tournament_id'] = $targetTournamentId;
        $row['champion_player_id'] = $sourcePlayoff['champion_player_id'] !== null
            ? ($playerMap[(int) $sourcePlayoff['champion_player_id']] ?? throw new RuntimeException('Missing champion map.'))
            : null;
        $targetPlayoffId = $insertRow($db, $targetPrefix . 'tournament_playoffs', $row);

        $sourceEntries = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_playoff_entries` WHERE playoff_id={$sourcePlayoffId} ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceEntries as $sourceEntry) {
            $row = $sourceEntry;
            unset($row['id']);
            $row['playoff_id'] = $targetPlayoffId;
            $row['player_id'] = $playerMap[(int) $sourceEntry['player_id']] ?? throw new RuntimeException('Missing playoff player map.');
            $row['source_group_id'] = $groupMap[(int) $sourceEntry['source_group_id']] ?? throw new RuntimeException('Missing playoff group map.');
            $insertRow($db, $targetPrefix . 'tournament_playoff_entries', $row);
        }

        $sourceNodes = $db->query(
            "SELECT * FROM `{$sourcePrefix}tournament_playoff_nodes` WHERE playoff_id={$sourcePlayoffId} ORDER BY round_number,position,id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceNodes as $sourceNode) {
            $row = $sourceNode;
            unset($row['id']);
            $row['playoff_id'] = $targetPlayoffId;
            foreach (['player_a_id','player_b_id','winner_player_id'] as $column) {
                $row[$column] = $sourceNode[$column] !== null
                    ? ($playerMap[(int) $sourceNode[$column]] ?? throw new RuntimeException("Missing playoff {$column} map."))
                    : null;
            }
            $row['match_id'] = $sourceNode['match_id'] !== null
                ? ($matchMap[(int) $sourceNode['match_id']] ?? throw new RuntimeException('Missing playoff match map.'))
                : null;
            $insertRow($db, $targetPrefix . 'tournament_playoff_nodes', $row);
        }

        $sourceRanking = $db->query(
            "SELECT * FROM `{$sourcePrefix}season_ranking_events` WHERE tournament_id={$sourceTournamentId} ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        foreach ($sourceRanking as $sourceEvent) {
            $row = $sourceEvent;
            unset($row['id']);
            $row['season_id'] = $targetSeasonId;
            $row['tournament_id'] = $targetTournamentId;
            $row['player_id'] = $playerMap[(int) $sourceEvent['player_id']] ?? throw new RuntimeException('Missing ranking player map.');
            $insertRow($db, $targetPrefix . 'season_ranking_events', $row);
        }

        if ($tableExists($db, $sourcePrefix . 'tournament_summaries') && $tableExists($db, $targetPrefix . 'tournament_summaries')) {
            $sourceSummary = $db->query(
                "SELECT * FROM `{$sourcePrefix}tournament_summaries` WHERE tournament_id={$sourceTournamentId} LIMIT 1"
            )->fetch_assoc() ?: null;
            if ($sourceSummary !== null) {
                $row = $sourceSummary;
                unset($row['id']);
                $row['tournament_id'] = $targetTournamentId;
                if (array_key_exists('created_by_user_account_id', $row)) $row['created_by_user_account_id'] = null;
                if (array_key_exists('updated_by_user_account_id', $row)) $row['updated_by_user_account_id'] = null;
                $insertRow($db, $targetPrefix . 'tournament_summaries', $row);
            }
        }

        $targetCounts = $countForTournament($db, $targetPrefix, $targetTournamentId);
        $spec = $sourceSpecByExternal[$externalId];
        foreach (['players','matches','legs','visits'] as $key) {
            if ($targetCounts[$key] !== (int) $spec['expected_' . $key]) {
                throw new RuntimeException("PROD staged {$externalId} {$key} mismatch: {$targetCounts[$key]}");
            }
        }
        $tournamentEvidence[$externalId] = [
            'source_tournament_id' => $sourceTournamentId,
            'target_tournament_id' => $targetTournamentId,
            'counts' => $targetCounts,
        ];
    }

    $externalIds = array_map(static fn (array $row): string => (string) $row['external_id'], $playerRefRows);
    $quotedExternalIds = implode(',', array_map(
        static fn (string $id): string => "'" . $db->real_escape_string($id) . "'",
        $externalIds
    ));
    $prodPlayerRefCount = (int) ($db->query(
        "SELECT COUNT(*) c FROM `{$targetPrefix}external_references`
         WHERE external_system='dartsatlas' AND external_entity_type='player' AND internal_entity_type='player'
           AND external_id IN ({$quotedExternalIds})"
    )->fetch_assoc()['c'] ?? 0);
    if ($prodPlayerRefCount !== (int) $expectedTotals['atlas_player_references']) {
        throw new RuntimeException("PROD player reference count mismatch: {$prodPlayerRefCount}");
    }

    $db->commit();

    echo 'ATLAS_PROD_PROMOTION_STAGED=yes' . PHP_EOL;
    echo 'ATLAS_PROD_PROMOTION_CREATED_PLAYERS=' . $createdPlayers . PHP_EOL;
    echo 'ATLAS_PROD_PROMOTION_REUSED_PLAYERS=' . $reusedPlayers . PHP_EOL;
    echo 'ATLAS_PROD_PROMOTION_TARGET_SEASON_ID=' . $targetSeasonId . PHP_EOL;
    echo 'ATLAS_PROD_PROMOTION_EVIDENCE=' . json_encode(
        $tournamentEvidence,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    ) . PHP_EOL;
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}
