<?php

declare(strict_types=1);

// Reconcile imported historical ranking points with the source series rules.

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$prefix = (string) (getenv('DB_TABLE_PREFIX') ?: '');
if ($prefix !== 'bd_prod_' || getenv('ALLOW_PROD_RANKING_RECONCILIATION') !== 'yes') {
    throw new RuntimeException('Production ranking reconciliation is not explicitly enabled.');
}

$db = new mysqli(
    (string) getenv('DB_HOST'),
    (string) getenv('DB_USERNAME'),
    (string) getenv('DB_PASSWORD'),
    (string) getenv('DB_NAME'),
    (int) getenv('DB_PORT')
);
$db->set_charset('utf8mb4');

$seasonExternalId = 'rFByCgOqI1rq';
$corrections = [
    'PvGa73emrY6e' => [
        '6dLds5Na0PsZ' => [4.0, 5.0],
        '3GERGyOGK1tY' => [3.0, 4.0],
        'DUq32rNObrUk' => [2.0, 3.0],
        'GFg9pZkPKrpU' => [2.0, 3.0],
    ],
    'X52gn3ioRLKD' => [
        'DUq32rNObrUk' => [4.0, 5.0],
        'GFg9pZkPKrpU' => [3.0, 4.0],
        '0J6SDLVfThUs' => [2.0, 3.0],
        'hE2Jzt55iTf2' => [2.0, 3.0],
    ],
    'CR1whrYUxIxa' => [
        '5sIceSlYm33a' => [4.0, 5.0],
        '6dLds5Na0PsZ' => [3.0, 4.0],
        '46u0DEjhFWti' => [2.0, 3.0],
        'nrAYPZl1pyuM' => [2.0, 3.0],
    ],
];

$expectedStandings = [
    'Arild Eidesund' => 25.0,
    'Thomas Kildal' => 24.0,
    'Vetle Ribe Davidsen' => 18.0,
    'Magnus Knudsen' => 16.0,
    'Andre Kendrick' => 14.0,
    'Andreas Tingstveit Hansen' => 14.0,
    'Jon-Henning Næss' => 13.0,
    'Tormod Haga' => 13.0,
    'Andreas Hasselgård' => 13.0,
    'Steffen Madsen' => 9.0,
    'Leif Atle Franksson' => 9.0,
    'Kjell Moyle' => 7.0,
    'Dan Christian Birkeland' => 5.0,
    'Bjørn Jarle Jahnsen' => 4.0,
    'Hans Øyvind Reiersen' => 2.0,
    'Tor Egil Olsen' => 2.0,
    'Sven Einar Davidsen' => 2.0,
    'Boye Buckingham' => 2.0,
    'Geir Atle Håland' => 1.0,
];

$ref = $db->prepare(
    "SELECT internal_id FROM `{$prefix}external_references`
     WHERE external_system='dartsatlas' AND external_entity_type=? AND external_id=?"
);
$entityType = 'season';
$ref->bind_param('ss', $entityType, $seasonExternalId);
$ref->execute();
$seasonRows = $ref->get_result()->fetch_all(MYSQLI_ASSOC);
if (count($seasonRows) !== 1) {
    throw new RuntimeException('Canonical PROD season reference is missing or ambiguous.');
}
$seasonId = (int) $seasonRows[0]['internal_id'];

$eloFingerprint = static function (mysqli $db, string $prefix, int $seasonId): string {
    $rows = $db->query(
        "SELECT player_id,CAST(rating AS CHAR) rating,matches_played
         FROM `{$prefix}elo_current_ratings` WHERE season_id={$seasonId} ORDER BY player_id"
    )->fetch_all(MYSQLI_ASSOC);
    return hash('sha256', json_encode($rows, JSON_THROW_ON_ERROR));
};
$beforeElo = $eloFingerprint($db, $prefix, $seasonId);

$findPlayer = $db->prepare(
    "SELECT internal_id FROM `{$prefix}external_references`
     WHERE external_system='dartsatlas' AND external_entity_type='player' AND external_id=?"
);
$findEvent = $db->prepare(
    "SELECT id,points,metadata_json FROM `{$prefix}season_ranking_events`
     WHERE season_id=? AND tournament_id=? AND player_id=? AND ruleset='linear_v1' AND status='applied'"
);
$updateEvent = $db->prepare(
    "UPDATE `{$prefix}season_ranking_events`
     SET points=?,metadata_json=?,updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND points=?"
);

$changed = 0;
$alreadyCorrect = 0;
$backfilledStarters = 0;
$db->begin_transaction();
try {
    // Historical DartsAtlas legs were imported with complete per-player visits,
    // but the legacy importer left starting_player_id NULL. In a completed 501
    // leg the starter has one extra visit when they win; otherwise both players
    // have the same number of visits and the non-winner started. Reconstructing
    // this source fact makes the canonical LA tie-break match DartsAtlas.
    $starterRows = $db->query(
        "SELECT l.id,l.winner_player_id,m.player_a_id,m.player_b_id,
                SUM(CASE WHEN v.player_id=m.player_a_id THEN 1 ELSE 0 END) player_a_visits,
                SUM(CASE WHEN v.player_id=m.player_b_id THEN 1 ELSE 0 END) player_b_visits
           FROM `{$prefix}legs` l
           JOIN `{$prefix}matches` m ON m.id=l.match_id
           JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
           JOIN `{$prefix}visits` v ON v.leg_id=l.id
          WHERE t.season_id={$seasonId} AND l.status='completed'
            AND l.winner_player_id IS NOT NULL AND l.starting_player_id IS NULL
          GROUP BY l.id,l.winner_player_id,m.player_a_id,m.player_b_id"
    )->fetch_all(MYSQLI_ASSOC);
    $updateStarter = $db->prepare(
        "UPDATE `{$prefix}legs` SET starting_player_id=? WHERE id=? AND starting_player_id IS NULL"
    );
    foreach ($starterRows as $leg) {
        $winnerId = (int) $leg['winner_player_id'];
        $playerAId = (int) $leg['player_a_id'];
        $playerBId = (int) $leg['player_b_id'];
        $playerAVisits = (int) $leg['player_a_visits'];
        $playerBVisits = (int) $leg['player_b_visits'];
        if ($winnerId !== $playerAId && $winnerId !== $playerBId) {
            throw new RuntimeException("Leg {$leg['id']} winner is not one of the match players.");
        }
        if ($playerAVisits < 1 || $playerBVisits < 1 || abs($playerAVisits - $playerBVisits) > 1) {
            throw new RuntimeException("Cannot derive DartsAtlas starter for leg {$leg['id']}.");
        }
        if ($playerAVisits === $playerBVisits) {
            $starterId = $winnerId === $playerAId ? $playerBId : $playerAId;
        } elseif ($playerAVisits === $playerBVisits + 1 && $winnerId === $playerAId) {
            $starterId = $playerAId;
        } elseif ($playerBVisits === $playerAVisits + 1 && $winnerId === $playerBId) {
            $starterId = $playerBId;
        } else {
            throw new RuntimeException("DartsAtlas visit order contradicts the winner for leg {$leg['id']}.");
        }
        $legId = (int) $leg['id'];
        $updateStarter->bind_param('ii', $starterId, $legId);
        $updateStarter->execute();
        if ($updateStarter->affected_rows !== 1) {
            throw new RuntimeException("Starter for leg {$legId} was not backfilled exactly once.");
        }
        $backfilledStarters++;
    }

    foreach ($corrections as $tournamentExternalId => $players) {
        $entityType = 'tournament';
        $ref->bind_param('ss', $entityType, $tournamentExternalId);
        $ref->execute();
        $tournamentRows = $ref->get_result()->fetch_all(MYSQLI_ASSOC);
        if (count($tournamentRows) !== 1) {
            throw new RuntimeException("Tournament reference {$tournamentExternalId} is missing or ambiguous.");
        }
        $tournamentId = (int) $tournamentRows[0]['internal_id'];
        $tournament = $db->query(
            "SELECT season_id,status FROM `{$prefix}tournaments` WHERE id={$tournamentId}"
        )->fetch_assoc();
        if ((int) ($tournament['season_id'] ?? 0) !== $seasonId || ($tournament['status'] ?? '') !== 'completed') {
            throw new RuntimeException("Tournament {$tournamentExternalId} is not a completed tournament in the target season.");
        }

        foreach ($players as $playerExternalId => [$oldPoints, $newPoints]) {
            $findPlayer->bind_param('s', $playerExternalId);
            $findPlayer->execute();
            $playerRows = $findPlayer->get_result()->fetch_all(MYSQLI_ASSOC);
            if (count($playerRows) !== 1) {
                throw new RuntimeException("Player reference {$playerExternalId} is missing or ambiguous.");
            }
            $playerId = (int) $playerRows[0]['internal_id'];
            $findEvent->bind_param('iii', $seasonId, $tournamentId, $playerId);
            $findEvent->execute();
            $events = $findEvent->get_result()->fetch_all(MYSQLI_ASSOC);
            if (count($events) !== 1) {
                throw new RuntimeException("Expected one applied ranking event for {$tournamentExternalId}/{$playerExternalId}.");
            }
            $event = $events[0];
            $current = (float) $event['points'];
            if (abs($current - $newPoints) < 0.0001) {
                $alreadyCorrect++;
                continue;
            }
            if (abs($current - $oldPoints) >= 0.0001) {
                throw new RuntimeException("Unexpected current points for {$tournamentExternalId}/{$playerExternalId}: {$current}.");
            }
            $metadata = json_decode((string) ($event['metadata_json'] ?? '{}'), true);
            if (!is_array($metadata)) {
                $metadata = [];
            }
            $metadata['calculation'] = 'dartsatlas_linear_field_size';
            $metadata['ranking_reference'] = 'Darts Atlas linear table: 9-16 entrants';
            $metadataJson = json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
            $eventId = (int) $event['id'];
            $updateEvent->bind_param('dsid', $newPoints, $metadataJson, $eventId, $oldPoints);
            $updateEvent->execute();
            if ($updateEvent->affected_rows !== 1) {
                throw new RuntimeException("Ranking event {$eventId} was not updated exactly once.");
            }
            $changed++;
        }
    }

    $rows = $db->query(
        "SELECT p.display_name,ROUND(SUM(e.points),2) points
         FROM `{$prefix}season_ranking_events` e
         JOIN `{$prefix}players` p ON p.id=e.player_id
         WHERE e.season_id={$seasonId} AND e.ruleset='linear_v1' AND e.status='applied'
         GROUP BY p.id,p.display_name"
    )->fetch_all(MYSQLI_ASSOC);
    $actual = [];
    foreach ($rows as $row) {
        $actual[(string) $row['display_name']] = (float) $row['points'];
    }
    if (count($actual) !== count($expectedStandings)) {
        throw new RuntimeException('Canonical standings player count differs from DartsAtlas.');
    }
    foreach ($expectedStandings as $name => $points) {
        if (!array_key_exists($name, $actual) || abs($actual[$name] - $points) >= 0.0001) {
            throw new RuntimeException("Canonical points do not match DartsAtlas for {$name}.");
        }
    }

    $remainingNullStarters = (int) $db->query(
        "SELECT COUNT(*) c FROM `{$prefix}legs` l
         JOIN `{$prefix}matches` m ON m.id=l.match_id
         JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
         WHERE t.season_id={$seasonId} AND l.status='completed'
           AND l.winner_player_id IS NOT NULL AND l.starting_player_id IS NULL
           AND EXISTS (SELECT 1 FROM `{$prefix}visits` v WHERE v.leg_id=l.id)"
    )->fetch_assoc()['c'];
    if ($remainingNullStarters !== 0) {
        throw new RuntimeException("Completed DartsAtlas legs still lack a starter: {$remainingNullStarters}.");
    }

    $duplicates = (int) $db->query(
        "SELECT COUNT(*) c FROM (
           SELECT club_id,LOWER(TRIM(display_name)) normalized
           FROM `{$prefix}players`
           WHERE is_active=1 AND merged_into_player_id IS NULL
           GROUP BY club_id,normalized HAVING COUNT(*)>1
         ) duplicate_names"
    )->fetch_assoc()['c'];
    if ($duplicates !== 0) {
        throw new RuntimeException("Active PROD player duplicates remain: {$duplicates}.");
    }

    $db->commit();
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}

$afterElo = $eloFingerprint($db, $prefix, $seasonId);
if (!hash_equals($beforeElo, $afterElo)) {
    throw new RuntimeException('ELO changed during ranking-points reconciliation.');
}

echo "DARTSATLAS_POINTS_RECONCILED=yes season_id={$seasonId} changed={$changed} already_correct={$alreadyCorrect} starters_backfilled={$backfilledStarters} elo_unchanged=yes\n";
