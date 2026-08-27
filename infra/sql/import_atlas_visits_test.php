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
    throw new RuntimeException("Refusing Atlas visit import outside bd_test_: {$prefix}");
}

$sourcePath = $argv[1] ?? '';
if ($sourcePath === '' || !is_file($sourcePath)) {
    throw new RuntimeException('Usage: php import_atlas_visits_test.php <visits-json>');
}
$source = json_decode((string) file_get_contents($sourcePath), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($source) || ($source['tournament_external_id'] ?? null) !== 'fpC4m4hIZdjZ') {
    throw new RuntimeException('Unexpected Atlas visit payload.');
}
$matches = is_array($source['matches'] ?? null) ? $source['matches'] : [];
if (count($matches) !== 63) {
    throw new RuntimeException('Expected visit payload for 63 matches, got ' . count($matches));
}
foreach ($matches as $externalId => $payload) {
    if (!is_array($payload) || ($payload['ok'] ?? false) !== true || ($payload['external_id'] ?? null) !== $externalId) {
        throw new RuntimeException("Invalid visit payload for {$externalId}");
    }
    if (!is_array($payload['legs'] ?? null) || $payload['legs'] === []) {
        throw new RuntimeException("No legs in visit payload for {$externalId}");
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

$normalise = static function (string $value): string {
    $value = html_entity_decode(trim($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return mb_strtolower((string) preg_replace('/\s+/u', ' ', $value), 'UTF-8');
};

$tournamentId = null;
$stmt = $db->prepare(
    "SELECT internal_id FROM `{$prefix}external_references`
     WHERE external_system='dartsatlas' AND external_entity_type='tournament' AND external_id='fpC4m4hIZdjZ' LIMIT 1"
);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();
if ($row !== null) $tournamentId = (int) $row['internal_id'];
if ($tournamentId === null) {
    $stmt = $db->prepare("SELECT id FROM `{$prefix}tournaments` WHERE name='Mandagsserien #1' AND DATE(start_at)='2026-08-10' LIMIT 1");
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if ($row !== null) $tournamentId = (int) $row['id'];
}
if ($tournamentId === null) {
    throw new RuntimeException('Mandagsserien #1 is not present in TEST.');
}

$findMatchByReference = $db->prepare(
    "SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.best_of_legs,
            pa.display_name AS player_a_name,pb.display_name AS player_b_name
       FROM `{$prefix}external_references` r
       INNER JOIN `{$prefix}matches` m ON m.id=r.internal_id AND r.internal_entity_type='match'
       INNER JOIN `{$prefix}players` pa ON pa.id=m.player_a_id
       INNER JOIN `{$prefix}players` pb ON pb.id=m.player_b_id
      WHERE r.external_system='dartsatlas' AND r.external_entity_type='match' AND r.external_id=? AND m.tournament_id=?
      LIMIT 1"
);
$findMatchByMetadata = $db->prepare(
    "SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.best_of_legs,
            pa.display_name AS player_a_name,pb.display_name AS player_b_name
       FROM `{$prefix}matches` m
       INNER JOIN `{$prefix}players` pa ON pa.id=m.player_a_id
       INNER JOIN `{$prefix}players` pb ON pb.id=m.player_b_id
      WHERE m.tournament_id=?
        AND JSON_UNQUOTE(JSON_EXTRACT(m.provider_metadata,'$.external_id'))=?
      LIMIT 1"
);

$legInsert = $db->prepare(
    "INSERT INTO `{$prefix}legs`
     (match_id,leg_number,starting_player_id,winner_player_id,status,start_score,finished_at)
     VALUES (?,?,NULL,?,'completed',501,NULL)"
);
$visitInsert = $db->prepare(
    "INSERT INTO `{$prefix}visits`
     (match_id,leg_id,player_id,visit_number,score,darts_used,input_mode,darts_json,is_bust,remaining_after)
     VALUES (?,?,?,?,?,?,'sum',NULL,0,?)"
);
$statsUpdate = $db->prepare(
    "UPDATE `{$prefix}match_statistics`
        SET darts_thrown=?, checkout_hits=?, highest_checkout=?, score_100_plus=?, score_140_plus=?, score_180=?,
            provider_metadata=JSON_SET(COALESCE(provider_metadata,JSON_OBJECT()),'$.visits_source','dartsatlas_match_page')
      WHERE match_id=? AND player_id=?"
);

$totalLegs = 0;
$totalVisits = 0;
$totalDarts = 0;
$zeroVisits = 0;
$matchCount = 0;

$db->begin_transaction();
try {
    foreach ($matches as $externalId => $payload) {
        $findMatchByReference->bind_param('si', $externalId, $tournamentId);
        $findMatchByReference->execute();
        $localMatch = $findMatchByReference->get_result()->fetch_assoc() ?: null;
        if ($localMatch === null) {
            $findMatchByMetadata->bind_param('is', $tournamentId, $externalId);
            $findMatchByMetadata->execute();
            $localMatch = $findMatchByMetadata->get_result()->fetch_assoc() ?: null;
        }
        if ($localMatch === null) {
            throw new RuntimeException("Local match not found for Atlas match {$externalId}");
        }

        $matchId = (int) $localMatch['id'];
        $playerAId = (int) $localMatch['player_a_id'];
        $playerBId = (int) $localMatch['player_b_id'];
        $sourceA = (string) ($payload['players']['a'] ?? '');
        $sourceB = (string) ($payload['players']['b'] ?? '');
        $localAName = (string) $localMatch['player_a_name'];
        $localBName = (string) $localMatch['player_b_name'];

        if ($normalise($sourceA) === $normalise($localAName) && $normalise($sourceB) === $normalise($localBName)) {
            $sourceSideToPlayer = ['a' => $playerAId, 'b' => $playerBId];
        } elseif ($normalise($sourceA) === $normalise($localBName) && $normalise($sourceB) === $normalise($localAName)) {
            $sourceSideToPlayer = ['a' => $playerBId, 'b' => $playerAId];
        } else {
            throw new RuntimeException("Player mismatch for Atlas match {$externalId}: {$sourceA} / {$sourceB} vs {$localAName} / {$localBName}");
        }

        $parsedWins = ['a' => 0, 'b' => 0];
        foreach ($payload['legs'] as $leg) {
            $winnerSide = (string) ($leg['winner_side'] ?? '');
            if (!isset($sourceSideToPlayer[$winnerSide])) {
                throw new RuntimeException("Invalid leg winner side in {$externalId}");
            }
            $parsedWins[$winnerSide]++;
        }
        $winnerSide = $parsedWins['a'] > $parsedWins['b'] ? 'a' : 'b';
        if ($parsedWins['a'] === $parsedWins['b'] || $sourceSideToPlayer[$winnerSide] !== (int) $localMatch['winner_player_id']) {
            throw new RuntimeException("Parsed leg winner does not match stored result for {$externalId}");
        }
        if (count($payload['legs']) > (int) $localMatch['best_of_legs']) {
            throw new RuntimeException("Too many parsed legs for {$externalId}");
        }

        $deleteVisits = $db->prepare("DELETE v FROM `{$prefix}visits` v INNER JOIN `{$prefix}legs` l ON l.id=v.leg_id WHERE l.match_id=?");
        $deleteVisits->bind_param('i', $matchId);
        $deleteVisits->execute();
        $deleteVisits->close();
        $deleteLegs = $db->prepare("DELETE FROM `{$prefix}legs` WHERE match_id=?");
        $deleteLegs->bind_param('i', $matchId);
        $deleteLegs->execute();
        $deleteLegs->close();

        $derivedStats = [
            $playerAId => ['darts' => 0, 'checkouts' => 0, 'highest_checkout' => 0, '100' => 0, '140' => 0, '180' => 0],
            $playerBId => ['darts' => 0, 'checkouts' => 0, 'highest_checkout' => 0, '100' => 0, '140' => 0, '180' => 0],
        ];

        foreach ($payload['legs'] as $leg) {
            $legNumber = (int) ($leg['leg_number'] ?? 0);
            $winnerSide = (string) $leg['winner_side'];
            $winnerPlayerId = $sourceSideToPlayer[$winnerSide];
            if ($legNumber < 1) throw new RuntimeException("Invalid leg number in {$externalId}");

            $legInsert->bind_param('iii', $matchId, $legNumber, $winnerPlayerId);
            $legInsert->execute();
            $legId = (int) $legInsert->insert_id;
            $totalLegs++;

            foreach (['a' => 'player_a_visits', 'b' => 'player_b_visits'] as $side => $visitKey) {
                $playerId = $sourceSideToPlayer[$side];
                $visits = is_array($leg[$visitKey] ?? null) ? $leg[$visitKey] : [];
                if ($visits === []) throw new RuntimeException("Missing visits for {$externalId} leg {$legNumber} side {$side}");
                foreach ($visits as $visit) {
                    $visitNumber = (int) ($visit['visit_number'] ?? 0);
                    $score = (int) ($visit['score'] ?? -1);
                    $dartsUsed = (int) ($visit['darts_used'] ?? 0);
                    $remainingAfter = (int) ($visit['remaining_after'] ?? -1);
                    if ($visitNumber < 1 || $score < 0 || $score > 180 || $dartsUsed < 1 || $dartsUsed > 3 || $remainingAfter < 0 || $remainingAfter > 501) {
                        throw new RuntimeException("Invalid visit in {$externalId} leg {$legNumber}");
                    }
                    $visitInsert->bind_param('iiiii ii', $matchId, $legId, $playerId, $visitNumber, $score, $dartsUsed, $remainingAfter);
                    $visitInsert->execute();
                    $totalVisits++;
                    $totalDarts += $dartsUsed;
                    if ($score === 0) $zeroVisits++;

                    $derivedStats[$playerId]['darts'] += $dartsUsed;
                    if ($score === 180) $derivedStats[$playerId]['180']++;
                    elseif ($score >= 140) $derivedStats[$playerId]['140']++;
                    elseif ($score >= 100) $derivedStats[$playerId]['100']++;
                }
                if ($winnerSide === $side) {
                    $lastVisit = $visits[array_key_last($visits)];
                    $checkout = (int) ($lastVisit['score'] ?? 0);
                    $derivedStats[$playerId]['checkouts']++;
                    $derivedStats[$playerId]['highest_checkout'] = max($derivedStats[$playerId]['highest_checkout'], $checkout);
                }
            }
        }

        foreach ($derivedStats as $playerId => $stats) {
            $darts = (int) $stats['darts'];
            $checkouts = (int) $stats['checkouts'];
            $highestCheckout = (int) $stats['highest_checkout'];
            $score100 = (int) $stats['100'];
            $score140 = (int) $stats['140'];
            $score180 = (int) $stats['180'];
            $statsUpdate->bind_param('iiiiiiii', $darts, $checkouts, $highestCheckout, $score100, $score140, $score180, $matchId, $playerId);
            $statsUpdate->execute();
        }
        $matchCount++;
    }

    $countLegs = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}legs` l INNER JOIN `{$prefix}matches` m ON m.id=l.match_id WHERE m.tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    $countVisits = (int) ($db->query("SELECT COUNT(*) c FROM `{$prefix}visits` v INNER JOIN `{$prefix}matches` m ON m.id=v.match_id WHERE m.tournament_id={$tournamentId}")->fetch_assoc()['c'] ?? 0);
    if ($matchCount !== 63 || $countLegs !== $totalLegs || $countVisits !== $totalVisits || $countLegs < 63 || $countVisits < 500) {
        throw new RuntimeException('Post-import visit count validation failed: ' . json_encode([
            'matches' => $matchCount,
            'legs' => $countLegs,
            'visits' => $countVisits,
            'expected_legs' => $totalLegs,
            'expected_visits' => $totalVisits,
        ]));
    }

    $db->commit();
    echo "ATLAS_VISITS_IMPORT_OK=yes\n";
    echo "tournament_id={$tournamentId}\n";
    echo "matches={$matchCount}\n";
    echo "legs={$totalLegs}\n";
    echo "visits={$totalVisits}\n";
    echo "darts={$totalDarts}\n";
    echo "zero_score_visits={$zeroVisits}\n";
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
} finally {
    $findMatchByReference->close();
    $findMatchByMetadata->close();
    $legInsert->close();
    $visitInsert->close();
    $statsUpdate->close();
    $db->close();
}
