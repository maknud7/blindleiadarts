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

$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_test_') {
    throw new RuntimeException("Refusing Atlas history import outside bd_test_: {$prefix}");
}

$sourcePath = $argv[1] ?? '';
if ($sourcePath === '' || !is_file($sourcePath)) {
    throw new RuntimeException('Usage: php import_atlas_series_one_test.php <probe-json>');
}
$source = json_decode((string) file_get_contents($sourcePath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($source) || ($source['tournament_external_id'] ?? null) !== 'fpC4m4hIZdjZ') {
    throw new RuntimeException('Unexpected Atlas source payload.');
}
$pages = is_array($source['pages'] ?? null) ? $source['pages'] : [];
foreach (['root', 'groups', 'group-1', 'group-2', 'results'] as $requiredPage) {
    if (!isset($pages[$requiredPage]) || (int) ($pages[$requiredPage]['status'] ?? 0) !== 200) {
        throw new RuntimeException("Missing successful source page: {$requiredPage}");
    }
}

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$seasonExternalId = 'rFByCgOqI1rq';
$tournamentExternalId = 'fpC4m4hIZdjZ';
$seasonName = 'Mandagsserien – Høst 2026';
$tournamentName = 'Mandagsserien #1';
$tournamentDate = '2026-08-10';
$tournamentStartAt = '2026-08-10 18:30:00';
$seasonStartsOn = '2026-08-10';
$seasonEndsOn = '2026-12-07';
$externalSystem = 'dartsatlas';

$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $value = mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
    return $value;
};

$externalPlayers = [];
$groupExternalOrder = [];
foreach ([1 => 'group-1', 2 => 'group-2'] as $groupNumber => $pageName) {
    $groupExternalOrder[$groupNumber] = [];
    foreach ((array) ($pages[$pageName]['players'] ?? []) as $href => $name) {
        if (!preg_match('~/player_stats/([^/?#]+)~', (string) $href, $m)) {
            continue;
        }
        $externalId = (string) $m[1];
        $displayName = trim((string) $name);
        if ($displayName === '') continue;
        $externalPlayers[$externalId] = $displayName;
        $groupExternalOrder[$groupNumber][] = $externalId;
    }
}
if (count($externalPlayers) !== 16 || count($groupExternalOrder[1]) !== 8 || count($groupExternalOrder[2]) !== 8) {
    throw new RuntimeException('Expected exactly 16 players split 8+8, got ' . json_encode([
        'players' => count($externalPlayers),
        'group1' => count($groupExternalOrder[1]),
        'group2' => count($groupExternalOrder[2]),
    ]));
}

$nameToExternal = [];
foreach ($externalPlayers as $externalId => $name) {
    $nameToExternal[$normalise($name)] = $externalId;
}

$parseMatch = static function (string $externalId, string $label, string $sourcePage, ?int $groupNumber) use ($externalPlayers, $nameToExternal, $normalise): array {
    $label = trim((string) preg_replace('/\s+/u', ' ', $label));
    if (!preg_match('/\bBest\s+of\s+(\d+)\b/i', $label, $best)) {
        throw new RuntimeException("Missing Best of for match {$externalId}: {$label}");
    }
    $bestOf = (int) $best[1];
    $legsToWin = intdiv($bestOf, 2) + 1;

    $roundLabel = null;
    $roundNumber = null;
    if (preg_match('/\bRound\s+(\d+)\b/i', $label, $round)) {
        $roundNumber = (int) $round[1];
        $roundLabel = 'Round ' . $roundNumber;
    } elseif (preg_match('/\b(Quarter-Final|Semi-Final|Final)\b/i', $label, $round)) {
        $canonical = strtolower($round[1]);
        $roundLabel = $canonical === 'quarter-final' ? 'Quarter-Final' : ($canonical === 'semi-final' ? 'Semi-Final' : 'Final');
    }

    $positions = [];
    foreach ($externalPlayers as $playerExternalId => $name) {
        $pos = mb_stripos($label, $name, 0, 'UTF-8');
        if ($pos !== false) {
            $positions[] = ['pos' => $pos, 'external_id' => $playerExternalId, 'name' => $name];
        }
    }
    usort($positions, static fn(array $a, array $b): int => $a['pos'] <=> $b['pos']);
    if (count($positions) < 2) {
        throw new RuntimeException("Could not resolve both players for match {$externalId}: {$label}");
    }
    $a = $positions[0];
    $b = $positions[1];
    $aEnd = $a['pos'] + mb_strlen($a['name'], 'UTF-8');
    $between = mb_substr($label, $aEnd, $b['pos'] - $aEnd, 'UTF-8');
    $afterB = mb_substr($label, $b['pos'] + mb_strlen($b['name'], 'UTF-8'), null, 'UTF-8');
    if (!preg_match('/\b(\d{1,2})\b/u', $between, $scoreA) || !preg_match('/^\s*(\d{1,2})\b/u', $afterB, $scoreB)) {
        throw new RuntimeException("Could not parse score for match {$externalId}: {$label}");
    }
    $scoreA = (int) $scoreA[1];
    $scoreB = (int) $scoreB[1];
    if ($scoreA === $scoreB || max($scoreA, $scoreB) < $legsToWin) {
        throw new RuntimeException("Match {$externalId} is not a completed decisive result: {$label}");
    }
    preg_match_all('/\b(\d{1,3}(?:\.\d{1,2})?)\s*Avg\b/i', $label, $averages);
    $averageA = isset($averages[1][0]) ? (float) $averages[1][0] : null;
    $averageB = isset($averages[1][1]) ? (float) $averages[1][1] : null;
    $winnerExternalId = $scoreA > $scoreB ? $a['external_id'] : $b['external_id'];

    $stageOrder = 0;
    if ($groupNumber !== null) {
        $stageOrder = (($roundNumber ?? 0) * 10) + $groupNumber;
    } else {
        $stageOrder = match ($roundLabel) {
            'Quarter-Final' => 100,
            'Semi-Final' => 110,
            'Final' => 120,
            default => 130,
        };
    }

    return [
        'external_id' => $externalId,
        'source_page' => $sourcePage,
        'group_number' => $groupNumber,
        'round_label' => $roundLabel,
        'round_number' => $roundNumber,
        'best_of_legs' => $bestOf,
        'legs_to_win' => $legsToWin,
        'player_a_external_id' => $a['external_id'],
        'player_b_external_id' => $b['external_id'],
        'score_a' => $scoreA,
        'score_b' => $scoreB,
        'winner_external_id' => $winnerExternalId,
        'average_a' => $averageA,
        'average_b' => $averageB,
        'raw_label' => $label,
        'stage_order' => $stageOrder,
    ];
};

$matches = [];
foreach ([1 => 'group-1', 2 => 'group-2'] as $groupNumber => $pageName) {
    foreach ((array) ($pages[$pageName]['links'] ?? []) as $href => $label) {
        if (!preg_match('~^/matches/([^/?#]+)$~', (string) $href, $m)) continue;
        $match = $parseMatch((string) $m[1], (string) $label, $pageName, $groupNumber);
        $matches[$match['external_id']] = $match;
    }
}
$playoffMatches = [];
foreach ((array) ($pages['results']['links'] ?? []) as $href => $label) {
    if (!preg_match('~^/matches/([^/?#]+)$~', (string) $href, $m)) continue;
    $match = $parseMatch((string) $m[1], (string) $label, 'results', null);
    $matches[$match['external_id']] = $match;
    $playoffMatches[] = $match;
}
if (count($matches) !== 63) {
    throw new RuntimeException('Expected 63 completed matches for Mandagsserien #1, got ' . count($matches));
}

usort($playoffMatches, static function (array $a, array $b): int {
    $rank = ['Quarter-Final' => 1, 'Semi-Final' => 2, 'Final' => 3];
    return ($rank[$a['round_label']] ?? 99) <=> ($rank[$b['round_label']] ?? 99);
});
$final = null;
foreach ($playoffMatches as $match) {
    if ($match['round_label'] === 'Final') $final = $match;
}
if ($final === null) throw new RuntimeException('Final not found in source.');
$championExternalId = $final['winner_external_id'];
$finalistExternalId = $final['winner_external_id'] === $final['player_a_external_id'] ? $final['player_b_external_id'] : $final['player_a_external_id'];

$semifinalLosers = [];
$quarterfinalLosers = [];
foreach ($playoffMatches as $match) {
    $loser = $match['winner_external_id'] === $match['player_a_external_id'] ? $match['player_b_external_id'] : $match['player_a_external_id'];
    if ($match['round_label'] === 'Semi-Final') $semifinalLosers[] = $loser;
    if ($match['round_label'] === 'Quarter-Final') $quarterfinalLosers[] = $loser;
}

$db->begin_transaction();
try {
    $clubStmt = $db->prepare("SELECT id FROM `{$prefix}clubs` WHERE slug='blindleia-dartklubb' LIMIT 1");
    $clubStmt->execute();
    $club = $clubStmt->get_result()->fetch_assoc();
    $clubStmt->close();
    if ($club === null) throw new RuntimeException('Blindleia test club not found.');
    $clubId = (int) $club['id'];

    // Resolve each historical identity to one canonical TEST player. Prefer a linked active row
    // when old duplicates exist; never create duplicate records when a matching name is present.
    $localPlayers = [];
    $duplicates = [];
    $allLocalRows = $db->query("SELECT id,display_name,member_id,is_active FROM `{$prefix}players` WHERE club_id={$clubId} OR club_id IS NULL ORDER BY id")->fetch_all(MYSQLI_ASSOC);
    $byName = [];
    foreach ($allLocalRows as $row) {
        $byName[$normalise((string) $row['display_name'])][] = $row;
    }
    foreach ($externalPlayers as $externalId => $displayName) {
        $candidates = $byName[$normalise($displayName)] ?? [];
        if ($candidates === []) {
            $active = 1;
            $insert = $db->prepare("INSERT INTO `{$prefix}players` (club_id,display_name,is_active,member_link_source) VALUES (?,?,?,'dartsatlas_import')");
            $insert->bind_param('isi', $clubId, $displayName, $active);
            $insert->execute();
            $localId = (int) $insert->insert_id;
            $insert->close();
        } else {
            usort($candidates, static function (array $a, array $b): int {
                $linkedA = $a['member_id'] !== null ? 1 : 0;
                $linkedB = $b['member_id'] !== null ? 1 : 0;
                if ($linkedA !== $linkedB) return $linkedB <=> $linkedA;
                $activeA = (int) ($a['is_active'] ?? 0);
                $activeB = (int) ($b['is_active'] ?? 0);
                if ($activeA !== $activeB) return $activeB <=> $activeA;
                return (int) $a['id'] <=> (int) $b['id'];
            });
            $localId = (int) $candidates[0]['id'];
            if (count($candidates) > 1) $duplicates[$displayName] = count($candidates);
        }
        $localPlayers[$externalId] = $localId;
    }

    $referenceUpsert = $db->prepare(
        "INSERT INTO `{$prefix}external_references`
         (external_system,external_entity_type,external_id,internal_entity_type,internal_id,sync_state,last_synced_at)
         VALUES (?,?,?,?,?,'synced',NOW())
         ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),internal_id=VALUES(internal_id),sync_state='synced',last_synced_at=NOW()"
    );
    $putReference = static function (string $externalType, string $externalId, string $internalType, int $internalId) use ($referenceUpsert, $externalSystem): void {
        $referenceUpsert->bind_param('ssssi', $externalSystem, $externalType, $externalId, $internalType, $internalId);
        $referenceUpsert->execute();
    };

    foreach ($localPlayers as $externalId => $localId) {
        $putReference('player', $externalId, 'player', $localId);
    }

    $seasonId = null;
    $refFind = $db->prepare("SELECT internal_id FROM `{$prefix}external_references` WHERE external_system=? AND external_entity_type=? AND external_id=? LIMIT 1");
    $externalType = 'season';
    $refFind->bind_param('sss', $externalSystem, $externalType, $seasonExternalId);
    $refFind->execute();
    $row = $refFind->get_result()->fetch_assoc();
    if ($row !== null) $seasonId = (int) $row['internal_id'];
    if ($seasonId === null) {
        $findSeason = $db->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id=? AND name=? LIMIT 1");
        $findSeason->bind_param('is', $clubId, $seasonName);
        $findSeason->execute();
        $seasonRow = $findSeason->get_result()->fetch_assoc();
        $findSeason->close();
        if ($seasonRow !== null) $seasonId = (int) $seasonRow['id'];
    }
    $db->query("UPDATE `{$prefix}seasons` SET is_active=0,status=IF(status='active','draft',status) WHERE club_id={$clubId}");
    if ($seasonId === null) {
        $active = 1;
        $status = 'active';
        $ranking = 'linear';
        $insert = $db->prepare("INSERT INTO `{$prefix}seasons` (club_id,name,starts_on,ends_on,is_active,status,ranking_method) VALUES (?,?,?,?,?,?,?)");
        $insert->bind_param('isssiss', $clubId, $seasonName, $seasonStartsOn, $seasonEndsOn, $active, $status, $ranking);
        $insert->execute();
        $seasonId = (int) $insert->insert_id;
        $insert->close();
    } else {
        $update = $db->prepare("UPDATE `{$prefix}seasons` SET name=?,starts_on=?,ends_on=?,is_active=1,status='active',ranking_method='linear' WHERE id=?");
        $update->bind_param('sssi', $seasonName, $seasonStartsOn, $seasonEndsOn, $seasonId);
        $update->execute();
        $update->close();
    }
    $putReference('season', $seasonExternalId, 'season', $seasonId);

    $tournamentId = null;
    $externalType = 'tournament';
    $refFind->bind_param('sss', $externalSystem, $externalType, $tournamentExternalId);
    $refFind->execute();
    $row = $refFind->get_result()->fetch_assoc();
    if ($row !== null) $tournamentId = (int) $row['internal_id'];
    $slug = 'mandagsserien-1-2026';
    $metadata = json_encode([
        'source' => 'dartsatlas_history_import',
        'external_id' => $tournamentExternalId,
        'external_season_id' => $seasonExternalId,
        'source_url' => 'https://www.dartsatlas.com/tournaments/' . $tournamentExternalId,
        'source_date' => $tournamentDate,
        'completeness' => ['matches' => 'complete', 'match_averages' => 'complete', 'legs' => 'not_yet_imported', 'visits' => 'not_yet_imported'],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($tournamentId === null) {
        $insert = $db->prepare(
            "INSERT INTO `{$prefix}tournaments`
             (club_id,season_id,name,slug,provider_system,provider_metadata,status,start_at,elo_enabled)
             VALUES (?,?,?,?,'historical_import',?,'completed',?,1)"
        );
        $insert->bind_param('iissss', $clubId, $seasonId, $tournamentName, $slug, $metadata, $tournamentStartAt);
        $insert->execute();
        $tournamentId = (int) $insert->insert_id;
        $insert->close();
    } else {
        $update = $db->prepare(
            "UPDATE `{$prefix}tournaments` SET club_id=?,season_id=?,name=?,slug=?,provider_system='historical_import',provider_metadata=?,status='completed',start_at=?,elo_enabled=1 WHERE id=?"
        );
        $update->bind_param('iissssi', $clubId, $seasonId, $tournamentName, $slug, $metadata, $tournamentStartAt, $tournamentId);
        $update->execute();
        $update->close();
    }
    $putReference('tournament', $tournamentExternalId, 'tournament', $tournamentId);

    // Registrations and source identity references.
    $registration = $db->prepare(
        "INSERT INTO `{$prefix}tournament_players` (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source)
         VALUES (?,?,'checked_in','legacy',?,'legacy')
         ON DUPLICATE KEY UPDATE status='checked_in',registration_source='legacy',checked_in_at=VALUES(checked_in_at),checkin_source='legacy'"
    );
    foreach ($localPlayers as $localId) {
        $registration->bind_param('iis', $tournamentId, $localId, $tournamentStartAt);
        $registration->execute();
    }
    $registration->close();

    // Historical groups and final standings order from Atlas.
    $groupIds = [];
    $groupPositions = [];
    foreach ([1, 2] as $groupNumber) {
        $groupName = 'Group ' . $groupNumber;
        $find = $db->prepare("SELECT id FROM `{$prefix}tournament_groups` WHERE tournament_id=? AND sort_order=? LIMIT 1");
        $find->bind_param('ii', $tournamentId, $groupNumber);
        $find->execute();
        $groupRow = $find->get_result()->fetch_assoc();
        $find->close();
        if ($groupRow === null) {
            $mode = 'historical_import';
            $seed = 0;
            $insert = $db->prepare("INSERT INTO `{$prefix}tournament_groups` (tournament_id,name,sort_order,draw_mode,draw_seed,generated_at) VALUES (?,?,?,?,?,?)");
            $insert->bind_param('isisis', $tournamentId, $groupName, $groupNumber, $mode, $seed, $tournamentStartAt);
            $insert->execute();
            $groupId = (int) $insert->insert_id;
            $insert->close();
        } else {
            $groupId = (int) $groupRow['id'];
            $update = $db->prepare("UPDATE `{$prefix}tournament_groups` SET name=?,draw_mode='historical_import',draw_seed=0 WHERE id=?");
            $update->bind_param('si', $groupName, $groupId);
            $update->execute();
            $update->close();
        }
        $groupIds[$groupNumber] = $groupId;
        $db->query("DELETE FROM `{$prefix}tournament_group_players` WHERE group_id={$groupId}");
        $insertGroupPlayer = $db->prepare(
            "INSERT INTO `{$prefix}tournament_group_players` (group_id,tournament_player_id,position,seed_number,seed_rating,seed_rating_source)
             SELECT ?,tp.id,?,NULL,NULL,'dartsatlas_import' FROM `{$prefix}tournament_players` tp WHERE tp.tournament_id=? AND tp.player_id=? LIMIT 1"
        );
        foreach ($groupExternalOrder[$groupNumber] as $index => $externalId) {
            $position = $index + 1;
            $localId = $localPlayers[$externalId];
            $insertGroupPlayer->bind_param('iiii', $groupId, $position, $tournamentId, $localId);
            $insertGroupPlayer->execute();
            if ($insertGroupPlayer->affected_rows !== 1) throw new RuntimeException("Could not insert group player {$externalId}");
            $groupPositions[$externalId] = ['group_id' => $groupId, 'position' => $position];
        }
        $insertGroupPlayer->close();
    }

    $matchLocalIds = [];
    $matchImportOrder = [];
    $matchesOrdered = array_values($matches);
    usort($matchesOrdered, static function (array $a, array $b): int {
        $cmp = $a['stage_order'] <=> $b['stage_order'];
        return $cmp !== 0 ? $cmp : strcmp($a['external_id'], $b['external_id']);
    });
    $order = 0;
    foreach ($matchesOrdered as $match) {
        $order++;
        $playerAId = $localPlayers[$match['player_a_external_id']];
        $playerBId = $localPlayers[$match['player_b_external_id']];
        $winnerId = $localPlayers[$match['winner_external_id']];
        $groupId = $match['group_number'] !== null ? $groupIds[$match['group_number']] : null;
        $bracketLabel = $match['group_number'] !== null ? 'group' : 'single_elimination';
        $providerMetadata = json_encode([
            'source' => 'dartsatlas_history_import',
            'external_id' => $match['external_id'],
            'source_page' => $match['source_page'],
            'source_label' => $match['raw_label'],
            'source_scores' => [$match['score_a'], $match['score_b']],
            'import_order' => $order,
            'completeness' => 'aggregate_result_and_average',
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $matchId = null;
        $externalType = 'match';
        $externalId = $match['external_id'];
        $refFind->bind_param('sss', $externalSystem, $externalType, $externalId);
        $refFind->execute();
        $refRow = $refFind->get_result()->fetch_assoc();
        if ($refRow !== null) $matchId = (int) $refRow['internal_id'];

        $roundLabel = $match['round_label'];
        $roundNumber = $match['round_number'];
        $bestOf = $match['best_of_legs'];
        $legsToWin = $match['legs_to_win'];
        if ($matchId === null) {
            $insert = $db->prepare(
                "INSERT INTO `{$prefix}matches`
                 (tournament_id,tournament_group_id,round_label,round_number,bracket_label,provider_metadata,status,best_of_legs,legs_to_win,player_a_id,player_b_id,winner_player_id,finished_at)
                 VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?,?)"
            );
            $insert->bind_param('iisissiiiiis', $tournamentId, $groupId, $roundLabel, $roundNumber, $bracketLabel, $providerMetadata, $bestOf, $legsToWin, $playerAId, $playerBId, $winnerId, $tournamentStartAt);
            $insert->execute();
            $matchId = (int) $insert->insert_id;
            $insert->close();
        } else {
            $update = $db->prepare(
                "UPDATE `{$prefix}matches` SET tournament_id=?,tournament_group_id=?,round_label=?,round_number=?,bracket_label=?,provider_metadata=?,status='completed',best_of_legs=?,legs_to_win=?,player_a_id=?,player_b_id=?,winner_player_id=?,finished_at=? WHERE id=?"
            );
            $update->bind_param('iisissiiiiisi', $tournamentId, $groupId, $roundLabel, $roundNumber, $bracketLabel, $providerMetadata, $bestOf, $legsToWin, $playerAId, $playerBId, $winnerId, $tournamentStartAt, $matchId);
            $update->execute();
            $update->close();
        }
        $putReference('match', $externalId, 'match', $matchId);
        $matchLocalIds[$externalId] = $matchId;
        $matchImportOrder[$matchId] = $order;

        $stats = $db->prepare(
            "INSERT INTO `{$prefix}match_statistics` (match_id,player_id,legs_won,average,provider_metadata)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE legs_won=VALUES(legs_won),average=VALUES(average),provider_metadata=VALUES(provider_metadata),updated_at=NOW()"
        );
        $statsMeta = json_encode(['source' => 'dartsatlas_history_import', 'external_match_id' => $externalId], JSON_UNESCAPED_SLASHES);
        $scoreA = $match['score_a'];
        $scoreB = $match['score_b'];
        $averageA = $match['average_a'];
        $averageB = $match['average_b'];
        $stats->bind_param('iiids', $matchId, $playerAId, $scoreA, $averageA, $statsMeta);
        $stats->execute();
        $stats->bind_param('iiids', $matchId, $playerBId, $scoreB, $averageB, $statsMeta);
        $stats->execute();
        $stats->close();
    }
    $refFind->close();
    $referenceUpsert->close();

    // Rebuild explicit single-elimination structure from the seven Atlas bracket matches.
    $existingPlayoff = $db->prepare("SELECT id FROM `{$prefix}tournament_playoffs` WHERE tournament_id=? LIMIT 1");
    $existingPlayoff->bind_param('i', $tournamentId);
    $existingPlayoff->execute();
    $playoffRow = $existingPlayoff->get_result()->fetch_assoc();
    $existingPlayoff->close();
    if ($playoffRow !== null) {
        $oldId = (int) $playoffRow['id'];
        $db->query("DELETE FROM `{$prefix}tournament_playoff_nodes` WHERE playoff_id={$oldId}");
        $db->query("DELETE FROM `{$prefix}tournament_playoff_entries` WHERE playoff_id={$oldId}");
        $db->query("DELETE FROM `{$prefix}tournament_playoffs` WHERE id={$oldId}");
    }
    $championId = $localPlayers[$championExternalId];
    $insertPlayoff = $db->prepare(
        "INSERT INTO `{$prefix}tournament_playoffs` (tournament_id,format,qualifiers_per_group,bracket_size,best_of_legs,status,champion_player_id)
         VALUES (?,'single_elimination',4,8,3,'completed',?)"
    );
    $insertPlayoff->bind_param('ii', $tournamentId, $championId);
    $insertPlayoff->execute();
    $playoffId = (int) $insertPlayoff->insert_id;
    $insertPlayoff->close();

    $qfMatches = array_values(array_filter($playoffMatches, static fn(array $m): bool => $m['round_label'] === 'Quarter-Final'));
    $qualifiers = [];
    foreach ($qfMatches as $qf) {
        foreach ([$qf['player_a_external_id'], $qf['player_b_external_id']] as $externalId) {
            if (!in_array($externalId, $qualifiers, true)) $qualifiers[] = $externalId;
        }
    }
    $entryInsert = $db->prepare(
        "INSERT INTO `{$prefix}tournament_playoff_entries`
         (playoff_id,player_id,seed_number,source_group_id,source_group_position,source_points,source_leg_diff,source_legs_won)
         VALUES (?,?,?,?,?,0,0,0)"
    );
    foreach ($qualifiers as $index => $externalId) {
        $seed = $index + 1;
        $playerId = $localPlayers[$externalId];
        $sourceGroupId = $groupPositions[$externalId]['group_id'];
        $sourcePosition = $groupPositions[$externalId]['position'];
        $entryInsert->bind_param('iiiii', $playoffId, $playerId, $seed, $sourceGroupId, $sourcePosition);
        $entryInsert->execute();
    }
    $entryInsert->close();

    $nodeInsert = $db->prepare(
        "INSERT INTO `{$prefix}tournament_playoff_nodes`
         (playoff_id,round_number,position,round_label,player_a_id,player_b_id,match_id,winner_player_id,status)
         VALUES (?,?,?,?,?,?,?,?,'completed')"
    );
    $positionsByRound = [1 => 0, 2 => 0, 3 => 0];
    foreach ($playoffMatches as $match) {
        $nodeRound = match ($match['round_label']) {'Quarter-Final' => 1, 'Semi-Final' => 2, 'Final' => 3, default => 0};
        if ($nodeRound === 0) continue;
        $position = ++$positionsByRound[$nodeRound];
        $roundLabel = $match['round_label'];
        $playerAId = $localPlayers[$match['player_a_external_id']];
        $playerBId = $localPlayers[$match['player_b_external_id']];
        $matchId = $matchLocalIds[$match['external_id']];
        $winnerId = $localPlayers[$match['winner_external_id']];
        $nodeInsert->bind_param('iiisiiii', $playoffId, $nodeRound, $position, $roundLabel, $playerAId, $playerBId, $matchId, $winnerId);
        $nodeInsert->execute();
    }
    $nodeInsert->close();

    // Atlas-style linear Order of Merit points for a 16-player event.
    $pointsByExternal = array_fill_keys(array_keys($externalPlayers), 1.0);
    $stageByExternal = array_fill_keys(array_keys($externalPlayers), 'Group stage');
    foreach ($quarterfinalLosers as $externalId) { $pointsByExternal[$externalId] = 2.0; $stageByExternal[$externalId] = 'Quarter-Final'; }
    foreach ($semifinalLosers as $externalId) { $pointsByExternal[$externalId] = 3.0; $stageByExternal[$externalId] = 'Semi-Final'; }
    $pointsByExternal[$finalistExternalId] = 4.0; $stageByExternal[$finalistExternalId] = 'Final';
    $pointsByExternal[$championExternalId] = 5.0; $stageByExternal[$championExternalId] = 'Champion';

    $rankingInsert = $db->prepare(
        "INSERT INTO `{$prefix}season_ranking_events`
         (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at)
         VALUES (?,?,?,?,?,?,?,'linear_v1','dartsatlas_import',?,'applied',?,?)
         ON DUPLICATE KEY UPDATE season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),points=VALUES(points),source=VALUES(source),source_reference=VALUES(source_reference),status='applied',metadata_json=VALUES(metadata_json),reverted_at=NULL,applied_at=VALUES(applied_at)"
    );
    foreach ($pointsByExternal as $externalId => $points) {
        $playerId = $localPlayers[$externalId];
        $stage = $stageByExternal[$externalId];
        $stageNumber = (int) $points;
        $sourceRef = $tournamentExternalId . ':' . $externalId;
        $rankingMeta = json_encode(['source' => 'dartsatlas_history_import', 'external_player_id' => $externalId], JSON_UNESCAPED_SLASHES);
        $rankingInsert->bind_param('iiiiidssss', $seasonId, $tournamentId, $playerId, $entrants = 16, $stage, $stageNumber, $points, $sourceRef, $rankingMeta, $tournamentStartAt);
        $rankingInsert->execute();
    }
    $rankingInsert->close();

    $db->commit();

    $counts = [];
    foreach ([
        'tournament_players' => "SELECT COUNT(*) c FROM `{$prefix}tournament_players` WHERE tournament_id={$tournamentId}",
        'groups' => "SELECT COUNT(*) c FROM `{$prefix}tournament_groups` WHERE tournament_id={$tournamentId}",
        'group_players' => "SELECT COUNT(*) c FROM `{$prefix}tournament_group_players` gp INNER JOIN `{$prefix}tournament_groups` g ON g.id=gp.group_id WHERE g.tournament_id={$tournamentId}",
        'matches' => "SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$tournamentId}",
        'match_statistics' => "SELECT COUNT(*) c FROM `{$prefix}match_statistics` ms INNER JOIN `{$prefix}matches` m ON m.id=ms.match_id WHERE m.tournament_id={$tournamentId}",
        'legs' => "SELECT COUNT(*) c FROM `{$prefix}legs` l INNER JOIN `{$prefix}matches` m ON m.id=l.match_id WHERE m.tournament_id={$tournamentId}",
        'visits' => "SELECT COUNT(*) c FROM `{$prefix}visits` v INNER JOIN `{$prefix}matches` m ON m.id=v.match_id WHERE m.tournament_id={$tournamentId}",
        'ranking_events' => "SELECT COUNT(*) c FROM `{$prefix}season_ranking_events` WHERE tournament_id={$tournamentId} AND status='applied'",
        'playoff_nodes' => "SELECT COUNT(*) c FROM `{$prefix}tournament_playoff_nodes` n INNER JOIN `{$prefix}tournament_playoffs` p ON p.id=n.playoff_id WHERE p.tournament_id={$tournamentId}",
    ] as $label => $sql) {
        $counts[$label] = (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0);
    }

    echo 'ATLAS_IMPORT_SERIES_ONE_OK=yes' . PHP_EOL;
    echo 'season_id=' . $seasonId . PHP_EOL;
    echo 'tournament_id=' . $tournamentId . PHP_EOL;
    echo 'champion=' . $externalPlayers[$championExternalId] . PHP_EOL;
    echo 'duplicates_resolved=' . json_encode($duplicates, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    echo 'counts=' . json_encode($counts, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    echo 'points=' . json_encode(array_map(static fn(string $externalId): array => [
        'player' => $externalPlayers[$externalId],
        'points' => $pointsByExternal[$externalId],
        'stage' => $stageByExternal[$externalId],
    ], array_keys($externalPlayers)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
} finally {
    $db->close();
}
