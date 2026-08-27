<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $matchesTable = $prefix . 'matches';
    $tournamentsTable = $prefix . 'tournaments';
    $eventsTable = $prefix . 'elo_match_events';
    $currentTable = $prefix . 'elo_current_ratings';
    $snapshotsTable = $prefix . 'ranking_snapshots';

    $seasonRows = $mysqli->query(
        "SELECT DISTINCT t.season_id
         FROM `{$tournamentsTable}` t
         INNER JOIN `{$matchesTable}` m ON m.tournament_id=t.id
         WHERE t.season_id IS NOT NULL
           AND t.elo_enabled=1
           AND m.status='completed'
         ORDER BY t.season_id ASC"
    )->fetch_all(MYSQLI_ASSOC);

    foreach ($seasonRows as $seasonRow) {
        $seasonId = (int) $seasonRow['season_id'];

        $matchStmt = $mysqli->prepare(
            "SELECT m.id AS match_id, m.tournament_id, t.club_id, t.season_id,
                    m.player_a_id, m.player_b_id, m.winner_player_id,
                    COALESCE(m.finished_at, m.starts_at, t.start_at, m.created_at) AS occurred_at,
                    COALESCE(m.round_number, 0) AS round_number
             FROM `{$matchesTable}` m
             INNER JOIN `{$tournamentsTable}` t ON t.id=m.tournament_id
             WHERE t.season_id=?
               AND t.elo_enabled=1
               AND m.status='completed'
             ORDER BY occurred_at ASC, round_number ASC, m.id ASC"
        );
        $matchStmt->bind_param('i', $seasonId);
        $matchStmt->execute();
        $matches = $matchStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $matchStmt->close();

        if ($matches === []) {
            continue;
        }

        $mysqli->begin_transaction();
        try {
            $deleteCurrent = $mysqli->prepare("DELETE FROM `{$currentTable}` WHERE season_id=?");
            $deleteCurrent->bind_param('i', $seasonId);
            $deleteCurrent->execute();
            $deleteCurrent->close();

            $deleteSnapshots = $mysqli->prepare(
                "DELETE FROM `{$snapshotsTable}`
                 WHERE season_id=? AND ranking_type='elo'
                   AND JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.source'))='elo_ledger'"
            );
            $deleteSnapshots->bind_param('i', $seasonId);
            $deleteSnapshots->execute();
            $deleteSnapshots->close();

            $deleteEvents = $mysqli->prepare("DELETE FROM `{$eventsTable}` WHERE season_id=?");
            $deleteEvents->bind_param('i', $seasonId);
            $deleteEvents->execute();
            $deleteEvents->close();

            /** @var array<int,array{rating:float,played:int,last_event_id:?int}> $state */
            $state = [];

            $eventInsert = $mysqli->prepare(
                "INSERT INTO `{$eventsTable}`
                 (match_id,tournament_id,season_id,club_id,player_a_id,player_b_id,winner_player_id,
                  score_a,score_b,rating_a_before,rating_b_before,rating_a_after,rating_b_after,
                  delta_a,delta_b,matches_before_a,matches_before_b,k_a,k_b,status,applied_at,reverted_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,NULL)"
            );

            $snapshotInsert = $mysqli->prepare(
                "INSERT INTO `{$snapshotsTable}`
                 (season_id,tournament_id,player_id,ranking_type,scope_type,points,position,context_json,calculated_at)
                 VALUES (?,?,?,'elo','season',?,NULL,?,?)"
            );

            foreach ($matches as $match) {
                $matchId = (int) $match['match_id'];
                $tournamentId = (int) $match['tournament_id'];
                $clubId = (int) $match['club_id'];
                $playerAId = (int) $match['player_a_id'];
                $playerBId = (int) $match['player_b_id'];
                $winnerPlayerId = $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null;
                $occurredAt = substr((string) $match['occurred_at'], 0, 19);

                if (!isset($state[$playerAId])) {
                    $state[$playerAId] = ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];
                }
                if (!isset($state[$playerBId])) {
                    $state[$playerBId] = ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];
                }

                $ratingABefore = $state[$playerAId]['rating'];
                $ratingBBefore = $state[$playerBId]['rating'];
                $matchesBeforeA = $state[$playerAId]['played'];
                $matchesBeforeB = $state[$playerBId]['played'];
                $scoreA = $winnerPlayerId === null ? 0.5 : ($winnerPlayerId === $playerAId ? 1.0 : 0.0);
                $scoreB = 1.0 - $scoreA;
                $expectedA = 1.0 / (1.0 + (10.0 ** (($ratingBBefore - $ratingABefore) / 400.0)));
                $expectedB = 1.0 - $expectedA;
                $kA = $matchesBeforeA <= 10 ? 25.0 : 15.0;
                $kB = $matchesBeforeB <= 10 ? 25.0 : 15.0;
                $deltaA = $kA * ($scoreA - $expectedA);
                $deltaB = $kB * ($scoreB - $expectedB);
                $ratingAAfter = $ratingABefore + $deltaA;
                $ratingBAfter = $ratingBBefore + $deltaB;

                $eventInsert->bind_param(
                    'iiiiiiiddddddddiidds',
                    $matchId,
                    $tournamentId,
                    $seasonId,
                    $clubId,
                    $playerAId,
                    $playerBId,
                    $winnerPlayerId,
                    $scoreA,
                    $scoreB,
                    $ratingABefore,
                    $ratingBBefore,
                    $ratingAAfter,
                    $ratingBAfter,
                    $deltaA,
                    $deltaB,
                    $matchesBeforeA,
                    $matchesBeforeB,
                    $kA,
                    $kB,
                    $occurredAt
                );
                $eventInsert->execute();
                $eventId = (int) $eventInsert->insert_id;

                $state[$playerAId] = ['rating' => $ratingAAfter, 'played' => $matchesBeforeA + 1, 'last_event_id' => $eventId];
                $state[$playerBId] = ['rating' => $ratingBAfter, 'played' => $matchesBeforeB + 1, 'last_event_id' => $eventId];

                foreach ([
                    [$playerAId, $ratingABefore, $ratingAAfter, $deltaA, $matchesBeforeA, $matchesBeforeA + 1, $kA],
                    [$playerBId, $ratingBBefore, $ratingBAfter, $deltaB, $matchesBeforeB, $matchesBeforeB + 1, $kB],
                ] as $player) {
                    [$playerId, $before, $after, $delta, $matchesBefore, $matchesAfter, $k] = $player;
                    $context = json_encode([
                        'source' => 'elo_ledger',
                        'event_id' => $eventId,
                        'match_id' => $matchId,
                        'rating_before' => $before,
                        'rating_after' => $after,
                        'delta' => $delta,
                        'matches_before' => $matchesBefore,
                        'matches_after' => $matchesAfter,
                        'k' => $k,
                    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    $snapshotInsert->bind_param('iiidss', $seasonId, $tournamentId, $playerId, $after, $context, $occurredAt);
                    $snapshotInsert->execute();
                }
            }

            $eventInsert->close();
            $snapshotInsert->close();

            $currentInsert = $mysqli->prepare(
                "INSERT INTO `{$currentTable}` (season_id,player_id,rating,matches_played,last_event_id)
                 VALUES (?,?,?,?,?)"
            );
            foreach ($state as $playerId => $playerState) {
                $rating = (float) $playerState['rating'];
                $played = (int) $playerState['played'];
                $lastEventId = $playerState['last_event_id'];
                $currentInsert->bind_param('iidii', $seasonId, $playerId, $rating, $played, $lastEventId);
                $currentInsert->execute();
            }
            $currentInsert->close();

            $mysqli->commit();
            fwrite(STDOUT, sprintf("ELO rebuild season %d: %d matches, %d players\n", $seasonId, count($matches), count($state)));
        } catch (Throwable $error) {
            $mysqli->rollback();
            throw $error;
        }
    }
};
