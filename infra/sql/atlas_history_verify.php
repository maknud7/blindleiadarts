<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$requiredEnv = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException("Missing {$key}");
    }
    return trim($value);
};

$options = getopt('', [
    'external:',
    'expected-matches::',
    'expected-players::',
    'phase::',
    'require-visits::',
    'require-playoff::',
]);

$externalId = trim((string) ($options['external'] ?? ''));
if ($externalId === '') {
    throw new RuntimeException('Usage: php atlas_history_verify.php --external=<DartsAtlas tournament id> [--expected-matches=N] [--expected-players=N] [--phase=data|final]');
}

$expectedMatches = isset($options['expected-matches']) && $options['expected-matches'] !== false && $options['expected-matches'] !== ''
    ? (int) $options['expected-matches']
    : null;
$expectedPlayers = isset($options['expected-players']) && $options['expected-players'] !== false && $options['expected-players'] !== ''
    ? (int) $options['expected-players']
    : null;
$phase = strtolower(trim((string) ($options['phase'] ?? 'final')));
if (!in_array($phase, ['data', 'final'], true)) {
    throw new RuntimeException('phase must be data or final');
}
$requireVisits = !isset($options['require-visits']) || !in_array(strtolower((string) $options['require-visits']), ['0', 'false', 'no'], true);
$requirePlayoff = !isset($options['require-playoff']) || !in_array(strtolower((string) $options['require-playoff']), ['0', 'false', 'no'], true);

$prefix = $requiredEnv('DB_TABLE_PREFIX');
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    throw new RuntimeException('Invalid DB_TABLE_PREFIX');
}

$db = new mysqli(
    $requiredEnv('DB_HOST'),
    $requiredEnv('DB_USERNAME'),
    $requiredEnv('DB_PASSWORD'),
    $requiredEnv('DB_NAME'),
    (int) $requiredEnv('DB_PORT')
);
$db->set_charset('utf8mb4');

$failures = [];
$passes = 0;
$check = static function (bool $ok, string $code, string $message, array $context = []) use (&$failures, &$passes): void {
    $suffix = $context !== [] ? ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
    if ($ok) {
        $passes++;
        echo "PASS {$code}: {$message}{$suffix}\n";
        return;
    }
    $failures[] = ['code' => $code, 'message' => $message, 'context' => $context];
    echo "FAIL {$code}: {$message}{$suffix}\n";
};

$tableExists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    return $exists;
};

$externalReferences = $prefix . 'external_references';
$tournaments = $prefix . 'tournaments';
$matchesTable = $prefix . 'matches';
$tournamentPlayers = $prefix . 'tournament_players';
$groupsTable = $prefix . 'tournament_groups';
$groupPlayers = $prefix . 'tournament_group_players';
$legsTable = $prefix . 'legs';
$visitsTable = $prefix . 'visits';
$statisticsTable = $prefix . 'match_statistics';
$playoffsTable = $prefix . 'tournament_playoffs';
$playoffNodes = $prefix . 'tournament_playoff_nodes';
$rankingEvents = $prefix . 'season_ranking_events';

$stmt = $db->prepare(
    "SELECT t.*
       FROM `{$externalReferences}` er
       INNER JOIN `{$tournaments}` t ON t.id=er.internal_id
      WHERE er.external_system='dartsatlas'
        AND er.external_entity_type='tournament'
        AND er.internal_entity_type='tournament'
        AND er.external_id=?
      LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$tournament = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();

$check($tournament !== null, 'tournament_reference', 'DartsAtlas tournament reference resolves to one local tournament.', ['external_id' => $externalId]);
if ($tournament === null) {
    echo json_encode(['ok' => false, 'external_id' => $externalId, 'failures' => $failures], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
    exit(1);
}

$tournamentId = (int) $tournament['id'];
$tournamentName = (string) ($tournament['name'] ?? '');
echo "ATLAS_HISTORY_QA tournament={$tournamentId} name=" . json_encode($tournamentName, JSON_UNESCAPED_UNICODE) . " phase={$phase}\n";

if ($phase === 'final') {
    $check((string) ($tournament['status'] ?? '') === 'completed', 'tournament_status', 'Tournament lifecycle is completed.', ['status' => $tournament['status'] ?? null]);
    $check(!empty($tournament['end_at']), 'tournament_end_at', 'Completed tournament has end_at, matching canonical tournament lifecycle.', ['start_at' => $tournament['start_at'] ?? null, 'end_at' => $tournament['end_at'] ?? null]);
}

$stmt = $db->prepare("SELECT COUNT(*) AS cnt FROM `{$tournamentPlayers}` WHERE tournament_id=?");
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$participantCount = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
$stmt->close();
$check($participantCount > 0, 'participants_present', 'Tournament has participants.', ['count' => $participantCount]);
if ($expectedPlayers !== null) {
    $check($participantCount === $expectedPlayers, 'participants_expected', 'Participant count matches source manifest.', ['expected' => $expectedPlayers, 'actual' => $participantCount]);
}

$stmt = $db->prepare(
    "SELECT COUNT(*) AS cnt
       FROM `{$tournamentPlayers}` tp
      WHERE tp.tournament_id=?
        AND NOT EXISTS (
            SELECT 1 FROM `{$matchesTable}` m
             WHERE m.tournament_id=tp.tournament_id
               AND (m.player_a_id=tp.player_id OR m.player_b_id=tp.player_id)
        )"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$participantsWithoutMatches = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
$stmt->close();
$check($participantsWithoutMatches === 0, 'participants_have_matches', 'Every registered historical participant is represented in match history.', ['without_matches' => $participantsWithoutMatches]);

if ($tableExists($db, $groupsTable) && $tableExists($db, $groupPlayers)) {
    $stmt = $db->prepare(
        "SELECT COUNT(DISTINCT gp.tournament_player_id) AS cnt
           FROM `{$groupsTable}` g
           INNER JOIN `{$groupPlayers}` gp ON gp.group_id=g.id
          WHERE g.tournament_id=?"
    );
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $groupedParticipants = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
    $stmt->close();
    $check($groupedParticipants === $participantCount, 'group_assignments', 'All tournament participants are assigned to imported groups.', ['participants' => $participantCount, 'grouped' => $groupedParticipants]);
}

$stmt = $db->prepare(
    "SELECT m.id,m.status,m.player_a_id,m.player_b_id,m.winner_player_id,m.finished_at,m.provider_metadata,
            er.external_id AS atlas_match_id
       FROM `{$matchesTable}` m
       LEFT JOIN `{$externalReferences}` er
         ON er.external_system='dartsatlas'
        AND er.external_entity_type='match'
        AND er.internal_entity_type='match'
        AND er.internal_id=m.id
      WHERE m.tournament_id=?
      ORDER BY m.id"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$matches = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
$stmt->close();
$matchCount = count($matches);
$check($matchCount > 0, 'matches_present', 'Tournament has imported matches.', ['count' => $matchCount]);
if ($expectedMatches !== null) {
    $check($matchCount === $expectedMatches, 'matches_expected', 'Match count matches source manifest.', ['expected' => $expectedMatches, 'actual' => $matchCount]);
}

$legAggregate = [];
$stmt = $db->prepare(
    "SELECT m.id AS match_id,
            COUNT(l.id) AS leg_count,
            SUM(CASE WHEN l.status='completed' THEN 1 ELSE 0 END) AS completed_legs,
            SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) AS a_legs,
            SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) AS b_legs,
            SUM(CASE WHEN l.winner_player_id IS NULL THEN 1 ELSE 0 END) AS missing_winner_legs
       FROM `{$matchesTable}` m
       LEFT JOIN `{$legsTable}` l ON l.match_id=m.id
      WHERE m.tournament_id=?
      GROUP BY m.id"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
    $legAggregate[(int) $row['match_id']] = $row;
}
$stmt->close();

$visitAggregate = [];
$stmt = $db->prepare(
    "SELECT m.id AS match_id,COUNT(v.id) AS visit_count,COUNT(DISTINCT v.leg_id) AS visited_legs
       FROM `{$matchesTable}` m
       LEFT JOIN `{$visitsTable}` v ON v.match_id=m.id
      WHERE m.tournament_id=?
      GROUP BY m.id"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
    $visitAggregate[(int) $row['match_id']] = $row;
}
$stmt->close();

$statsByMatch = [];
if ($tableExists($db, $statisticsTable)) {
    $stmt = $db->prepare(
        "SELECT ms.match_id,ms.player_id,ms.legs_won,ms.average
           FROM `{$statisticsTable}` ms
           INNER JOIN `{$matchesTable}` m ON m.id=ms.match_id
          WHERE m.tournament_id=?"
    );
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
        $statsByMatch[(int) $row['match_id']][(int) $row['player_id']] = $row;
    }
    $stmt->close();
}

$matchFailures = 0;
foreach ($matches as $match) {
    $id = (int) $match['id'];
    $playerA = (int) $match['player_a_id'];
    $playerB = (int) $match['player_b_id'];
    $winner = $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : 0;
    $meta = json_decode((string) ($match['provider_metadata'] ?? ''), true);
    $scores = is_array($meta) && isset($meta['source_scores']) && is_array($meta['source_scores']) ? array_values($meta['source_scores']) : null;
    $scoreA = $scores !== null && isset($scores[0]) ? (int) $scores[0] : null;
    $scoreB = $scores !== null && isset($scores[1]) ? (int) $scores[1] : null;
    $expectedLegs = $scoreA !== null && $scoreB !== null ? $scoreA + $scoreB : null;
    $legs = $legAggregate[$id] ?? [];
    $visits = $visitAggregate[$id] ?? [];
    $stats = $statsByMatch[$id] ?? [];

    $issues = [];
    if ((string) $match['status'] !== 'completed') $issues[] = 'status';
    if (!in_array($winner, [$playerA, $playerB], true)) $issues[] = 'winner';
    if (empty($match['finished_at'])) $issues[] = 'finished_at';
    if (empty($match['atlas_match_id'])) $issues[] = 'external_reference';
    if ($expectedLegs === null || $scoreA === $scoreB || max((int) $scoreA, (int) $scoreB) < 1) $issues[] = 'source_scores';
    if ($expectedLegs !== null) {
        if ((int) ($legs['leg_count'] ?? 0) !== $expectedLegs) $issues[] = 'leg_count';
        if ((int) ($legs['completed_legs'] ?? 0) !== $expectedLegs) $issues[] = 'leg_status';
        if ((int) ($legs['missing_winner_legs'] ?? 0) !== 0) $issues[] = 'leg_winner';
        if ((int) ($legs['a_legs'] ?? 0) !== $scoreA || (int) ($legs['b_legs'] ?? 0) !== $scoreB) $issues[] = 'leg_score';
        if ($requireVisits && ((int) ($visits['visit_count'] ?? 0) < 1 || (int) ($visits['visited_legs'] ?? 0) !== $expectedLegs)) $issues[] = 'visits';
        if (!isset($stats[$playerA], $stats[$playerB])) $issues[] = 'statistics_rows';
        else {
            if ((int) $stats[$playerA]['legs_won'] !== $scoreA || (int) $stats[$playerB]['legs_won'] !== $scoreB) $issues[] = 'statistics_score';
        }
    }
    if ($issues !== []) {
        $matchFailures++;
        echo 'MATCH_FAIL ' . json_encode([
            'match_id' => $id,
            'atlas_match_id' => $match['atlas_match_id'],
            'issues' => array_values(array_unique($issues)),
            'source_scores' => $scores,
            'legs' => $legs,
            'visits' => $visits,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }
}
$check($matchFailures === 0, 'match_integrity', 'Every imported match is complete from result through legs/visits/statistics.', ['failed_matches' => $matchFailures, 'matches' => $matchCount, 'require_visits' => $requireVisits]);

$stmt = $db->prepare(
    "SELECT COUNT(DISTINCT tp.player_id) AS cnt
       FROM `{$tournamentPlayers}` tp
      WHERE tp.tournament_id=?
        AND EXISTS (
            SELECT 1 FROM `{$externalReferences}` er
             WHERE er.external_system='dartsatlas'
               AND er.external_entity_type='player'
               AND er.internal_entity_type='player'
               AND er.internal_id=tp.player_id
        )"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$playersWithAtlasRef = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
$stmt->close();
$check($playersWithAtlasRef === $participantCount, 'player_references', 'Every participant resolves to a canonical player with a DartsAtlas reference.', ['participants' => $participantCount, 'with_reference' => $playersWithAtlasRef]);

$playoff = null;
if ($tableExists($db, $playoffsTable)) {
    $stmt = $db->prepare("SELECT * FROM `{$playoffsTable}` WHERE tournament_id=? LIMIT 1");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $playoff = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
}
if ($requirePlayoff) {
    $check($playoff !== null, 'playoff_present', 'Tournament has an imported playoff bracket.');
}
if ($playoff !== null) {
    $playoffId = (int) $playoff['id'];
    $champion = $playoff['champion_player_id'] !== null ? (int) $playoff['champion_player_id'] : 0;
    $check($champion > 0, 'playoff_champion', 'Playoff has a champion.', ['champion_player_id' => $champion ?: null]);
    if ($phase === 'final') {
        $check((string) ($playoff['status'] ?? '') === 'completed', 'playoff_status', 'Playoff lifecycle is completed.', ['status' => $playoff['status'] ?? null]);
    }

    $stmt = $db->prepare(
        "SELECT COUNT(*) AS node_count,
                SUM(CASE WHEN n.status='completed' THEN 1 ELSE 0 END) AS completed_nodes,
                SUM(CASE WHEN n.winner_player_id IS NULL THEN 1 ELSE 0 END) AS missing_winners,
                SUM(CASE WHEN n.match_id IS NULL THEN 1 ELSE 0 END) AS missing_matches,
                SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed_matches
           FROM `{$playoffNodes}` n
           LEFT JOIN `{$matchesTable}` m ON m.id=n.match_id
          WHERE n.playoff_id=?"
    );
    $stmt->bind_param('i', $playoffId);
    $stmt->execute();
    $nodes = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $nodeCount = (int) ($nodes['node_count'] ?? 0);
    $expectedNodes = max(0, (int) ($playoff['bracket_size'] ?? 0) - 1);
    $check($nodeCount === $expectedNodes, 'playoff_node_count', 'Playoff node count matches bracket size.', ['expected' => $expectedNodes, 'actual' => $nodeCount]);
    $check(
        (int) ($nodes['completed_nodes'] ?? 0) === $nodeCount
        && (int) ($nodes['missing_winners'] ?? 0) === 0
        && (int) ($nodes['missing_matches'] ?? 0) === 0
        && (int) ($nodes['completed_matches'] ?? 0) === $nodeCount,
        'playoff_nodes_complete',
        'Every playoff node points to a completed match and winner.',
        $nodes
    );

    $stmt = $db->prepare(
        "SELECT n.winner_player_id
           FROM `{$playoffNodes}` n
          WHERE n.playoff_id=?
          ORDER BY n.round_number DESC,n.position ASC
          LIMIT 1"
    );
    $stmt->bind_param('i', $playoffId);
    $stmt->execute();
    $finalWinner = (int) (($stmt->get_result()->fetch_assoc()['winner_player_id'] ?? 0));
    $stmt->close();
    $check($champion > 0 && $finalWinner === $champion, 'playoff_final_winner', 'Final node winner equals playoff champion.', ['champion' => $champion, 'final_winner' => $finalWinner]);
}

if ($tableExists($db, $rankingEvents) && !empty($tournament['season_id'])) {
    $stmt = $db->prepare("SELECT COUNT(DISTINCT player_id) AS cnt FROM `{$rankingEvents}` WHERE tournament_id=?");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $rankedPlayers = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
    $stmt->close();
    $check($rankedPlayers === $participantCount, 'season_ranking_events', 'Season ranking ledger contains one tournament result for every participant.', ['participants' => $participantCount, 'ranked_players' => $rankedPlayers]);
}

$summary = [
    'ok' => $failures === [],
    'phase' => $phase,
    'external_id' => $externalId,
    'tournament_id' => $tournamentId,
    'tournament_name' => $tournamentName,
    'participants' => $participantCount,
    'matches' => $matchCount,
    'passes' => $passes,
    'failures' => $failures,
];
echo "ATLAS_HISTORY_VERIFY_SUMMARY " . json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
if ($failures === []) {
    echo "ATLAS_HISTORY_VERIFY_OK=yes\n";
    exit(0);
}
exit(1);
