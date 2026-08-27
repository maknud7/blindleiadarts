<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};

$prefix = $required('DB_TABLE_PREFIX');
if ($prefix !== 'bd_test_') throw new RuntimeException("Refusing Atlas match import outside bd_test_: {$prefix}");

$manifestPath = $argv[1] ?? '';
$sourcePath = $argv[2] ?? '';
if ($manifestPath === '' || !is_file($manifestPath) || $sourcePath === '' || !is_file($sourcePath)) {
    throw new RuntimeException('Usage: php import_atlas_match_visits_test.php <manifest-json> <single-match-json>');
}
$manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
$source = json_decode((string) file_get_contents($sourcePath), true, 512, JSON_THROW_ON_ERROR);
$tournamentExternalId = trim((string) ($manifest['tournament_external_id'] ?? ''));
if ($tournamentExternalId === '') throw new RuntimeException('Manifest missing tournament_external_id.');
if (!is_array($source) || ($source['ok'] ?? false) !== true) throw new RuntimeException('Invalid Atlas match source payload.');
$externalId = trim((string) ($source['external_id'] ?? ''));
if ($externalId === '') throw new RuntimeException('Atlas match source missing external_id.');
$expectedMatchIds = array_map('strval', (array) ($manifest['match_external_ids'] ?? []));
if ($expectedMatchIds !== [] && !in_array($externalId, $expectedMatchIds, true)) {
    throw new RuntimeException("Match {$externalId} is not frozen in manifest.");
}
if (!is_array($source['legs'] ?? null) || $source['legs'] === []) throw new RuntimeException("No legs in visit payload for {$externalId}");

$db = new mysqli($required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'), $required('DB_NAME'), (int) $required('DB_PORT'));
$db->set_charset('utf8mb4');
$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

$stmt = $db->prepare(
    "SELECT er.internal_id AS tournament_id
       FROM `{$prefix}external_references` er
      WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament'
        AND er.external_id=? AND er.internal_entity_type='tournament' LIMIT 1"
);
$stmt->bind_param('s', $tournamentExternalId);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();
if ($row === null) throw new RuntimeException("Tournament {$tournamentExternalId} is not present in TEST.");
$tournamentId = (int) $row['tournament_id'];

$findMatch = $db->prepare(
    "SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.best_of_legs,m.finished_at,
            pa.display_name AS player_a_name,pb.display_name AS player_b_name
       FROM `{$prefix}external_references` er
       INNER JOIN `{$prefix}matches` m ON m.id=er.internal_id AND er.internal_entity_type='match'
       INNER JOIN `{$prefix}players` pa ON pa.id=m.player_a_id
       INNER JOIN `{$prefix}players` pb ON pb.id=m.player_b_id
      WHERE er.external_system='dartsatlas' AND er.external_entity_type='match' AND er.external_id=?
        AND m.tournament_id=? LIMIT 1"
);
$findMatch->bind_param('si', $externalId, $tournamentId);
$findMatch->execute();
$localMatch = $findMatch->get_result()->fetch_assoc() ?: null;
$findMatch->close();
if ($localMatch === null) throw new RuntimeException("Local match not found for Atlas match {$externalId}");

$matchId = (int) $localMatch['id'];
$playerAId = (int) $localMatch['player_a_id'];
$playerBId = (int) $localMatch['player_b_id'];
$sourceA = (string) ($source['players']['a'] ?? '');
$sourceB = (string) ($source['players']['b'] ?? '');
$localAName = (string) $localMatch['player_a_name'];
$localBName = (string) $localMatch['player_b_name'];
if ($normalise($sourceA) === $normalise($localAName) && $normalise($sourceB) === $normalise($localBName)) {
    $sideToPlayer = ['a' => $playerAId, 'b' => $playerBId];
} elseif ($normalise($sourceA) === $normalise($localBName) && $normalise($sourceB) === $normalise($localAName)) {
    $sideToPlayer = ['a' => $playerBId, 'b' => $playerAId];
} else {
    throw new RuntimeException("Player mismatch for {$externalId}: {$sourceA} / {$sourceB} vs {$localAName} / {$localBName}");
}

$wins = ['a' => 0, 'b' => 0];
foreach ($source['legs'] as $leg) {
    $side = (string) ($leg['winner_side'] ?? '');
    if (!isset($sideToPlayer[$side])) throw new RuntimeException("Invalid leg winner side in {$externalId}");
    $wins[$side]++;
}
if ($wins['a'] === $wins['b']) throw new RuntimeException("Parsed legs are tied for {$externalId}");
$winnerSide = $wins['a'] > $wins['b'] ? 'a' : 'b';
if ($sideToPlayer[$winnerSide] !== (int) $localMatch['winner_player_id']) throw new RuntimeException("Parsed winner differs from stored result for {$externalId}");
if (count($source['legs']) > (int) $localMatch['best_of_legs']) throw new RuntimeException("Too many legs for {$externalId}");

$finishedAt = trim((string) ($localMatch['finished_at'] ?? ''));
if ($finishedAt === '') throw new RuntimeException("Stored match {$externalId} has no finished_at.");

$deleteVisits = $db->prepare("DELETE FROM `{$prefix}visits` WHERE match_id=?");
$deleteLegs = $db->prepare("DELETE FROM `{$prefix}legs` WHERE match_id=?");
$legInsert = $db->prepare(
    "INSERT INTO `{$prefix}legs` (match_id,leg_number,starting_player_id,winner_player_id,status,start_score,finished_at)
     VALUES (?,?,NULL,?,'completed',501,?)"
);
$visitInsert = $db->prepare(
    "INSERT INTO `{$prefix}visits` (match_id,leg_id,player_id,visit_number,score,darts_used,input_mode,darts_json,is_bust,remaining_after)
     VALUES (?,?,?,?,?,?,'sum',NULL,0,?)"
);
$statsUpdate = $db->prepare(
    "UPDATE `{$prefix}match_statistics`
        SET darts_thrown=?,checkout_hits=?,highest_checkout=?,score_100_plus=?,score_140_plus=?,score_180=?,
            provider_metadata=JSON_SET(COALESCE(provider_metadata,JSON_OBJECT()),'$.visits_source','dartsatlas_match_page')
      WHERE match_id=? AND player_id=?"
);

$db->begin_transaction();
try {
    $deleteVisits->bind_param('i', $matchId); $deleteVisits->execute();
    $deleteLegs->bind_param('i', $matchId); $deleteLegs->execute();
    $stats = [
        $playerAId => ['darts'=>0,'checkouts'=>0,'highest'=>0,'100'=>0,'140'=>0,'180'=>0],
        $playerBId => ['darts'=>0,'checkouts'=>0,'highest'=>0,'100'=>0,'140'=>0,'180'=>0],
    ];
    $legCount = 0; $visitCount = 0; $dartsCount = 0;
    foreach ($source['legs'] as $leg) {
        $legNumber = (int) ($leg['leg_number'] ?? 0);
        $legWinnerSide = (string) ($leg['winner_side'] ?? '');
        if ($legNumber < 1 || !isset($sideToPlayer[$legWinnerSide])) throw new RuntimeException("Invalid leg in {$externalId}");
        $winnerPlayerId = $sideToPlayer[$legWinnerSide];
        $legInsert->bind_param('iiis', $matchId, $legNumber, $winnerPlayerId, $finishedAt);
        $legInsert->execute();
        $legId = (int) $legInsert->insert_id;
        $legCount++;

        foreach (['a'=>'player_a_visits','b'=>'player_b_visits'] as $side => $key) {
            $playerId = $sideToPlayer[$side];
            $visits = is_array($leg[$key] ?? null) ? $leg[$key] : [];
            if ($visits === []) throw new RuntimeException("Missing visits for {$externalId} leg {$legNumber} side {$side}");
            foreach ($visits as $visit) {
                $visitNumber = (int) ($visit['visit_number'] ?? 0);
                $score = (int) ($visit['score'] ?? -1);
                $darts = (int) ($visit['darts_used'] ?? 0);
                $remaining = (int) ($visit['remaining_after'] ?? -1);
                if ($visitNumber < 1 || $score < 0 || $score > 180 || $darts < 1 || $darts > 3 || $remaining < 0 || $remaining > 501) {
                    throw new RuntimeException("Invalid visit in {$externalId} leg {$legNumber}");
                }
                $visitInsert->bind_param('iiiiiii', $matchId, $legId, $playerId, $visitNumber, $score, $darts, $remaining);
                $visitInsert->execute();
                $visitCount++; $dartsCount += $darts; $stats[$playerId]['darts'] += $darts;
                if ($score === 180) $stats[$playerId]['180']++;
                elseif ($score >= 140) $stats[$playerId]['140']++;
                elseif ($score >= 100) $stats[$playerId]['100']++;
            }
            if ($legWinnerSide === $side) {
                $last = $visits[array_key_last($visits)];
                $checkout = (int) ($last['score'] ?? 0);
                $stats[$playerId]['checkouts']++;
                $stats[$playerId]['highest'] = max($stats[$playerId]['highest'], $checkout);
            }
        }
    }
    if ($legCount !== $wins['a'] + $wins['b']) throw new RuntimeException("Leg count mismatch for {$externalId}");
    if ($visitCount < $legCount * 2) throw new RuntimeException("Implausibly few visits for {$externalId}");

    foreach ($stats as $playerId => $s) {
        $darts=(int)$s['darts'];$checkouts=(int)$s['checkouts'];$highest=(int)$s['highest'];$s100=(int)$s['100'];$s140=(int)$s['140'];$s180=(int)$s['180'];
        $statsUpdate->bind_param('iiiiiiii', $darts, $checkouts, $highest, $s100, $s140, $s180, $matchId, $playerId);
        $statsUpdate->execute();
        if ($statsUpdate->affected_rows < 0) throw new RuntimeException("Statistics update failed for {$externalId}");
    }
    $db->commit();
    echo 'ATLAS_MATCH_IMPORT_OK ' . json_encode([
        'tournament_external_id'=>$tournamentExternalId,'match_external_id'=>$externalId,'match_id'=>$matchId,
        'legs'=>$legCount,'visits'=>$visitCount,'darts'=>$dartsCount
    ], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES) . PHP_EOL;
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
} finally {
    foreach ([$deleteVisits,$deleteLegs,$legInsert,$visitInsert,$statsUpdate] as $stmt) $stmt->close();
    $db->close();
}
