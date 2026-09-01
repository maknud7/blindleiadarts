<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};
if ($required('DB_TABLE_PREFIX') !== 'bd_test_') throw new RuntimeException('Round-four metadata completion is TEST-only.');
if ($required('ALLOW_TEST_ROUND_FOUR_METADATA_COMPLETION') !== 'yes') {
    throw new RuntimeException('Explicit round-four metadata completion allow flag is required.');
}

$db = new mysqli(
    $required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'),
    $required('DB_NAME'), (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = 'bd_test_';
$externalId = 'jort2WSBWFwN';
$stmt = $db->prepare(
    "SELECT t.id,t.season_id,t.start_at
       FROM `{$prefix}external_references` er
       INNER JOIN `{$prefix}tournaments` t ON t.id=er.internal_id
      WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament'
        AND er.external_id=? AND er.internal_entity_type='tournament' LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$tournament = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($tournament === null || (int) $tournament['season_id'] < 1 || empty($tournament['start_at'])) {
    throw new RuntimeException('Frozen TEST round four and season are required.');
}
$tournamentId = (int) $tournament['id'];
$seasonId = (int) $tournament['season_id'];
$appliedAt = (string) $tournament['start_at'];

$matches = $db->query(
    "SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.provider_metadata,
            COUNT(l.id) leg_count,
            SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) a_legs,
            SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) b_legs
       FROM `{$prefix}matches` m
       LEFT JOIN `{$prefix}legs` l ON l.match_id=m.id
      WHERE m.tournament_id={$tournamentId}
      GROUP BY m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.provider_metadata
      ORDER BY m.id"
)->fetch_all(MYSQLI_ASSOC);
if (count($matches) !== 37) throw new RuntimeException('Round-four match count drift during metadata completion.');
$legTotal = 0;
$updateMatch = $db->prepare("UPDATE `{$prefix}matches` SET provider_metadata=? WHERE id=?");
foreach ($matches as $match) {
    $aLegs = (int) $match['a_legs'];
    $bLegs = (int) $match['b_legs'];
    $legTotal += (int) $match['leg_count'];
    $expectedWinner = $aLegs > $bLegs ? (int) $match['player_a_id'] : (int) $match['player_b_id'];
    if ($aLegs === $bLegs || $expectedWinner !== (int) $match['winner_player_id']) {
        throw new RuntimeException('Stored result differs from validated leg winners for match ' . $match['id']);
    }
    $metadata = json_decode((string) ($match['provider_metadata'] ?? ''), true);
    if (!is_array($metadata)) $metadata = [];
    $metadata['source_scores'] = [$aLegs, $bLegs];
    $metadata['completeness'] = 'complete_with_visits';
    $encoded = json_encode($metadata, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $matchId = (int) $match['id'];
    $updateMatch->bind_param('si', $encoded, $matchId);
    $updateMatch->execute();
}
$updateMatch->close();
if ($legTotal !== 48) throw new RuntimeException("Round-four leg total drift: {$legTotal}");

$participants = $db->query(
    "SELECT player_id FROM `{$prefix}tournament_players` WHERE tournament_id={$tournamentId} ORDER BY player_id"
)->fetch_all(MYSQLI_ASSOC);
if (count($participants) !== 12) throw new RuntimeException('Round-four participant count drift.');
$ranking = [];
foreach ($participants as $participant) {
    $ranking[(int) $participant['player_id']] = ['points' => 1.0, 'stage' => 'Group stage', 'number' => 1];
}
$nodes = $db->query(
    "SELECT n.round_number,n.round_label,m.player_a_id,m.player_b_id,n.winner_player_id
       FROM `{$prefix}tournament_playoff_nodes` n
       INNER JOIN `{$prefix}tournament_playoffs` p ON p.id=n.playoff_id
       INNER JOIN `{$prefix}matches` m ON m.id=n.match_id
      WHERE p.tournament_id={$tournamentId}
      ORDER BY n.round_number,n.position"
)->fetch_all(MYSQLI_ASSOC);
if (count($nodes) !== 7) throw new RuntimeException('Round-four playoff node count drift.');
$maxRound = 0;
$championId = 0;
foreach ($nodes as $node) {
    $round = (int) $node['round_number'];
    $maxRound = max($maxRound, $round);
    $winner = (int) $node['winner_player_id'];
    $playerA = (int) $node['player_a_id'];
    $playerB = (int) $node['player_b_id'];
    if (!in_array($winner, [$playerA, $playerB], true)) throw new RuntimeException('Invalid playoff node winner.');
    $loser = $winner === $playerA ? $playerB : $playerA;
    $ranking[$loser] = ['points' => (float) ($round + 1), 'stage' => (string) $node['round_label'], 'number' => $round + 1];
    if ($round === 3) $championId = $winner;
}
if ($maxRound !== 3 || !isset($ranking[$championId])) throw new RuntimeException('Round-four final/champion could not be derived.');
$ranking[$championId] = ['points' => 5.0, 'stage' => 'Champion', 'number' => 5];

$distribution = [];
$upsert = $db->prepare(
    "INSERT INTO `{$prefix}season_ranking_events`
       (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,
        source_reference,status,metadata_json,applied_at,reverted_at)
     VALUES (?,?,?,?,?,?,?,'linear_v1','dartsatlas_import',?,'applied',?,?,NULL)
     ON DUPLICATE KEY UPDATE season_id=VALUES(season_id),entrants=VALUES(entrants),
       stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),points=VALUES(points),
       source=VALUES(source),source_reference=VALUES(source_reference),status='applied',
       metadata_json=VALUES(metadata_json),applied_at=VALUES(applied_at),reverted_at=NULL"
);
foreach ($ranking as $playerId => $result) {
    $points = (float) $result['points'];
    $stage = (string) $result['stage'];
    $stageNumber = (int) $result['number'];
    $entrants = 12;
    $sourceReference = $externalId . ':player-' . $playerId;
    $metadata = json_encode(['source' => 'validated_round_four_playoff_tree'], JSON_THROW_ON_ERROR);
    $upsert->bind_param('iiiisidsss', $seasonId, $tournamentId, $playerId, $entrants, $stage, $stageNumber, $points, $sourceReference, $metadata, $appliedAt);
    $upsert->execute();
    $key = (string) (int) $points;
    $distribution[$key] = ($distribution[$key] ?? 0) + 1;
}
$upsert->close();
ksort($distribution);
if ($distribution !== ['1' => 4, '2' => 4, '3' => 2, '4' => 1, '5' => 1]) {
    throw new RuntimeException('Round-four ranking distribution drift: ' . json_encode($distribution));
}

fwrite(STDOUT, 'ROUND4_TEST_METADATA_COMPLETE=yes ' . json_encode([
    'tournament_id' => $tournamentId,
    'matches' => count($matches),
    'legs' => $legTotal,
    'ranking_events' => count($ranking),
    'points_distribution' => $distribution,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
