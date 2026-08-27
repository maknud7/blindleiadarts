<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $matchesTable = $prefix . 'matches';
    $tournamentsTable = $prefix . 'tournaments';
    $playersTable = $prefix . 'players';
    $groupsTable = $prefix . 'tournament_groups';
    $playoffNodesTable = $prefix . 'tournament_playoff_nodes';
    $eventsTable = $prefix . 'elo_match_events';
    $currentTable = $prefix . 'elo_current_ratings';
    $snapshotsTable = $prefix . 'ranking_snapshots';

    $normalize = static fn (string $value): string => mb_strtolower(trim($value), 'UTF-8');

    $buildIdentityMap = static function (array $matches) use ($normalize): array {
        $groups = [];
        foreach ($matches as $match) {
            foreach (['a', 'b'] as $side) {
                $playerId = (int) $match['player_' . $side . '_id'];
                $memberValue = $match['player_' . $side . '_member_id'] ?? null;
                $memberId = $memberValue !== null ? (int) $memberValue : null;
                $name = $normalize((string) ($match['player_' . $side . '_name'] ?? ''));
                $clubId = (int) $match['club_id'];
                $groupKey = $name !== '' ? ($clubId . ':' . $name) : ('player:' . $playerId);
                $groups[$groupKey]['players'][$playerId] = $memberId;
                if ($memberId !== null && $memberId > 0) {
                    $groups[$groupKey]['members'][$memberId] = true;
                }
            }
        }

        $map = [];
        foreach ($groups as $groupKey => $group) {
            $memberIds = array_map('intval', array_keys($group['members'] ?? []));
            $singleMemberId = count($memberIds) === 1 ? $memberIds[0] : null;
            foreach ($group['players'] as $playerId => $memberId) {
                $playerId = (int) $playerId;
                $memberId = $memberId !== null ? (int) $memberId : null;
                if ($memberId !== null && $memberId > 0) {
                    $map[$playerId] = 'member:' . $memberId;
                } elseif ($singleMemberId !== null) {
                    $map[$playerId] = 'member:' . $singleMemberId;
                } elseif ($memberIds === []) {
                    $map[$playerId] = 'name:' . $groupKey;
                } else {
                    $map[$playerId] = 'player:' . $playerId;
                }
            }
        }
        return $map;
    };

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
        $sql = "SELECT m.id AS match_id, m.tournament_id, t.club_id, t.season_id,
                       m.player_a_id, m.player_b_id, m.winner_player_id,
                       m.round_label, m.round_number, m.bracket_label, m.tournament_group_id,
                       pa.display_name AS player_a_name, pa.member_id AS player_a_member_id,
                       pb.display_name AS player_b_name, pb.member_id AS player_b_member_id,
                       COALESCE(m.finished_at, m.starts_at, t.start_at, m.created_at) AS occurred_at,
                       CASE
                           WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,''))='group' THEN 0
                           WHEN pn.id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,'')) IN ('single_elimination','playoff','knockout') THEN 2
                           ELSE 1
                       END AS phase_order,
                       CASE
                           WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,''))='group'
                               THEN COALESCE(m.round_number,32767)
                           WHEN pn.id IS NOT NULL
                               THEN COALESCE(pn.round_number,m.round_number,32767)
                           ELSE COALESCE(m.round_number,32767)
                       END AS logical_round,
                       COALESCE(tg.sort_order,0) AS group_order,
                       COALESCE(pn.position,0) AS playoff_position,
                       pn.round_number AS playoff_round_number,
                       pn.round_label AS playoff_round_label,
                       COALESCE(t.start_at,m.created_at) AS tournament_order_at
                FROM `{$matchesTable}` m
                INNER JOIN `{$tournamentsTable}` t ON t.id=m.tournament_id
                INNER JOIN `{$playersTable}` pa ON pa.id=m.player_a_id
                INNER JOIN `{$playersTable}` pb ON pb.id=m.player_b_id
                LEFT JOIN `{$groupsTable}` tg ON tg.id=m.tournament_group_id
                LEFT JOIN `{$playoffNodesTable}` pn ON pn.match_id=m.id
                WHERE t.season_id=?
                  AND t.elo_enabled=1
                  AND m.status='completed'
                ORDER BY tournament_order_at ASC,
                         t.id ASC,
                         phase_order ASC,
                         logical_round ASC,
                         group_order ASC,
                         playoff_position ASC,
                         occurred_at ASC,
                         m.id ASC";
        $stmt = $mysqli->prepare($sql);
        $stmt->bind_param('i', $seasonId);
        $stmt->execute();
        $matches = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        if ($matches === []) {
            continue;
        }

        $identityByPlayer = $buildIdentityMap($matches);
        $identityPlayerIds = [];
        foreach ($identityByPlayer as $playerId => $identityKey) {
            $identityPlayerIds[$identityKey][(int) $playerId] = true;
        }
        $mergedAliases = 0;
        foreach ($identityPlayerIds as $ids) {
            $mergedAliases += max(0, count($ids) - 1);
        }

        // Verify that the source structure itself can be traversed as:
        // round robin -> quarter-final -> semi-final -> final.
        $phaseByTournament = [];
        $playoffRoundByTournament = [];
        foreach ($matches as $match) {
            $tournamentId = (int) $match['tournament_id'];
            $phase = (int) $match['phase_order'];
            $previousPhase = $phaseByTournament[$tournamentId] ?? -1;
            if ($phase < $previousPhase) {
                throw new RuntimeException("ELO phase order regressed in tournament {$tournamentId}.");
            }
            $phaseByTournament[$tournamentId] = $phase;

            if ($phase === 2) {
                $round = (int) $match['logical_round'];
                $previousRound = $playoffRoundByTournament[$tournamentId] ?? 0;
                if ($round < $previousRound) {
                    throw new RuntimeException("ELO playoff round order regressed in tournament {$tournamentId}.");
                }
                $playoffRoundByTournament[$tournamentId] = $round;

                $label = $normalize((string) ($match['playoff_round_label'] ?? $match['round_label'] ?? ''));
                $expected = null;
                if (str_contains($label, 'quarter') || str_contains($label, 'kvart')) $expected = 1;
                elseif (str_contains($label, 'semi')) $expected = 2;
                elseif ($label === 'final' || str_contains($label, 'finale')) $expected = 3;
                if ($expected !== null && $round !== $expected) {
                    throw new RuntimeException(sprintf(
                        'Unexpected playoff order in tournament %d: %s has round %d, expected %d.',
                        $tournamentId,
                        (string) ($match['playoff_round_label'] ?? $match['round_label']),
                        $round,
                        $expected
                    ));
                }
            }
        }

        $mysqli->begin_transaction();
        try {
            $deleteCurrent = $mysqli->prepare("DELETE FROM `{$currentTable}` WHERE season_id=?");
            $deleteCurrent->bind_param('i', $seasonId);
            $deleteCurrent->execute();
            $deleteCurrent->close();

            $deleteSnapshots = $mysqli->prepare("DELETE FROM `{$snapshotsTable}` WHERE season_id=? AND ranking_type='elo'");
            $deleteSnapshots->bind_param('i', $seasonId);
            $deleteSnapshots->execute();
            $deleteSnapshots->close();

            $deleteEvents = $mysqli->prepare("DELETE FROM `{$eventsTable}` WHERE season_id=?");
            $deleteEvents->bind_param('i', $seasonId);
            $deleteEvents->execute();
            $deleteEvents->close();

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

            /** @var array<string,array{rating:float,played:int,last_event_id:?int}> $state */
            $state = [];
            $trace = [];

            foreach ($matches as $match) {
                $matchId = (int) $match['match_id'];
                $tournamentId = (int) $match['tournament_id'];
                $clubId = (int) $match['club_id'];
                $playerAId = (int) $match['player_a_id'];
                $playerBId = (int) $match['player_b_id'];
                $keyA = $identityByPlayer[$playerAId] ?? ('player:' . $playerAId);
                $keyB = $identityByPlayer[$playerBId] ?? ('player:' . $playerBId);
                if ($keyA === $keyB) {
                    throw new RuntimeException("ELO identity collision in match {$matchId}: {$keyA}.");
                }

                $state[$keyA] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];
                $state[$keyB] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];

                $winnerId = $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null;
                $winnerKey = $winnerId !== null ? ($identityByPlayer[$winnerId] ?? ('player:' . $winnerId)) : null;
                $scoreA = $winnerKey === null ? 0.5 : ($winnerKey === $keyA ? 1.0 : 0.0);
                $scoreB = 1.0 - $scoreA;

                $ratingABefore = (float) $state[$keyA]['rating'];
                $ratingBBefore = (float) $state[$keyB]['rating'];
                $matchesBeforeA = (int) $state[$keyA]['played'];
                $matchesBeforeB = (int) $state[$keyB]['played'];
                $expectedA = 1.0 / (1.0 + (10.0 ** (($ratingBBefore - $ratingABefore) / 400.0)));
                $expectedB = 1.0 - $expectedA;
                $kA = $matchesBeforeA <= 10 ? 25.0 : 15.0;
                $kB = $matchesBeforeB <= 10 ? 25.0 : 15.0;
                $deltaA = $kA * ($scoreA - $expectedA);
                $deltaB = $kB * ($scoreB - $expectedB);
                $ratingAAfter = $ratingABefore + $deltaA;
                $ratingBAfter = $ratingBBefore + $deltaB;
                $occurredAt = substr((string) $match['occurred_at'], 0, 19);

                $eventInsert->bind_param(
                    'iiiiiiiddddddddiidds',
                    $matchId,
                    $tournamentId,
                    $seasonId,
                    $clubId,
                    $playerAId,
                    $playerBId,
                    $winnerId,
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

                $state[$keyA] = ['rating' => $ratingAAfter, 'played' => $matchesBeforeA + 1, 'last_event_id' => $eventId];
                $state[$keyB] = ['rating' => $ratingBAfter, 'played' => $matchesBeforeB + 1, 'last_event_id' => $eventId];

                foreach ([
                    [$keyA, $playerAId, $ratingABefore, $ratingAAfter, $deltaA, $matchesBeforeA, $matchesBeforeA + 1, $kA],
                    [$keyB, $playerBId, $ratingBBefore, $ratingBAfter, $deltaB, $matchesBeforeB, $matchesBeforeB + 1, $kB],
                ] as $player) {
                    [$identityKey, $playerId, $before, $after, $delta, $matchesBefore, $matchesAfter, $k] = $player;
                    if (isset($trace[$identityKey])) {
                        $previous = $trace[$identityKey];
                        if (abs((float) $previous['after'] - (float) $before) > 0.0001
                            || (int) $previous['matches_after'] !== (int) $matchesBefore) {
                            throw new RuntimeException(sprintf(
                                'ELO continuity broke for %s before match %d: %.4f/%d -> %.4f/%d.',
                                $identityKey,
                                $matchId,
                                (float) $previous['after'],
                                (int) $previous['matches_after'],
                                (float) $before,
                                (int) $matchesBefore
                            ));
                        }
                    } elseif (abs((float) $before - 1000.0) > 0.0001 || (int) $matchesBefore !== 0) {
                        throw new RuntimeException("ELO identity {$identityKey} did not start at 1000/0.");
                    }
                    $trace[$identityKey] = ['after' => $after, 'matches_after' => $matchesAfter];

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
                        'phase_order' => (int) $match['phase_order'],
                        'logical_round' => (int) $match['logical_round'],
                    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    $points = (float) $after;
                    $snapshotInsert->bind_param('iiidss', $seasonId, $tournamentId, $playerId, $points, $context, $occurredAt);
                    $snapshotInsert->execute();
                }
            }
            $eventInsert->close();
            $snapshotInsert->close();

            $currentInsert = $mysqli->prepare(
                "INSERT INTO `{$currentTable}` (season_id,player_id,rating,matches_played,last_event_id)
                 VALUES (?,?,?,?,?)"
            );
            ksort($identityByPlayer);
            foreach ($identityByPlayer as $playerId => $identityKey) {
                if (!isset($state[$identityKey])) continue;
                $rating = (float) $state[$identityKey]['rating'];
                $played = (int) $state[$identityKey]['played'];
                $lastEventId = $state[$identityKey]['last_event_id'] !== null ? (int) $state[$identityKey]['last_event_id'] : null;
                $playerId = (int) $playerId;
                $currentInsert->bind_param('iidii', $seasonId, $playerId, $rating, $played, $lastEventId);
                $currentInsert->execute();
            }
            $currentInsert->close();

            $mysqli->commit();
            fwrite(STDOUT, sprintf(
                "ELO chronology season %d: %d matches, %d canonical identities, %d duplicate player alias(es) joined; round robin -> playoff order and rating continuity verified.\n",
                $seasonId,
                count($matches),
                count($state),
                $mergedAliases
            ));
        } catch (Throwable $error) {
            $mysqli->rollback();
            throw $error;
        }
    }
};
