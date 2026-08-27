<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Service\EloCalculator;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class EloLedgerRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private EloCalculator $calculator;

    public function __construct(Database $database, ?EloCalculator $calculator = null)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->calculator = $calculator ?? new EloCalculator();
    }

    public function applyCompletedMatch(int $matchId): void
    {
        $match = $this->findMatch($matchId);
        if ($match === null
            || (string) $match['status'] !== 'completed'
            || (int) ($match['elo_enabled'] ?? 0) !== 1
            || $match['season_id'] === null) {
            return;
        }

        $seasonId = (int) $match['season_id'];
        $this->lockSeason($seasonId);

        $existing = $this->findEventByMatchId($matchId);
        $winnerId = $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null;
        if ($existing !== null
            && (string) $existing['status'] === 'applied'
            && ($existing['winner_player_id'] !== null ? (int) $existing['winner_player_id'] : null) === $winnerId) {
            return;
        }

        $playerAId = (int) $match['player_a_id'];
        $scoreA = $winnerId === null ? 0.5 : ($winnerId === $playerAId ? 1.0 : 0.0);
        $scoreB = 1.0 - $scoreA;
        $tournamentId = (int) $match['tournament_id'];
        $clubId = (int) $match['club_id'];
        $playerBId = (int) $match['player_b_id'];

        $sql = sprintf(
            'INSERT INTO `%1$selo_match_events`
             (match_id, tournament_id, season_id, club_id, player_a_id, player_b_id, winner_player_id,
              score_a, score_b, status, applied_at, reverted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "applied", CURRENT_TIMESTAMP(6), NULL)
             ON DUPLICATE KEY UPDATE
                tournament_id=VALUES(tournament_id), season_id=VALUES(season_id), club_id=VALUES(club_id),
                player_a_id=VALUES(player_a_id), player_b_id=VALUES(player_b_id), winner_player_id=VALUES(winner_player_id),
                score_a=VALUES(score_a), score_b=VALUES(score_b), status="applied",
                applied_at=CURRENT_TIMESTAMP(6), reverted_at=NULL, updated_at=NOW()',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param(
            'iiiiiiidd',
            $matchId,
            $tournamentId,
            $seasonId,
            $clubId,
            $playerAId,
            $playerBId,
            $winnerId,
            $scoreA,
            $scoreB
        );
        $stmt->execute();
        $stmt->close();

        $this->rebuildSeason($seasonId);
    }

    public function revertMatch(int $matchId): void
    {
        $event = $this->findEventByMatchId($matchId);
        if ($event === null || (string) $event['status'] !== 'applied') {
            return;
        }

        $seasonId = (int) $event['season_id'];
        $this->lockSeason($seasonId);
        $sql = sprintf(
            'UPDATE `%1$selo_match_events`
             SET status="reverted", reverted_at=CURRENT_TIMESTAMP(6), updated_at=NOW()
             WHERE match_id=? AND status="applied"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $stmt->close();

        $this->rebuildSeason($seasonId);
    }

    /** @return array<string, mixed>|null */
    public function findEventByMatchId(int $matchId): ?array
    {
        $sql = sprintf('SELECT * FROM `%1$selo_match_events` WHERE match_id=? LIMIT 1', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function rebuildSeason(int $seasonId): void
    {
        $events = $this->listAppliedEvents($seasonId);
        $identityByPlayer = $this->buildIdentityMap($events);

        /** @var array<string, array{rating:float,played:int,last_event_id:?int}> $state */
        $state = [];
        /** @var array<string, array<int,true>> $aliases */
        $aliases = [];
        $timeline = [];

        foreach ($events as $event) {
            $playerAId = (int) $event['player_a_id'];
            $playerBId = (int) $event['player_b_id'];
            $keyA = $identityByPlayer[$playerAId] ?? ('player:' . $playerAId);
            $keyB = $identityByPlayer[$playerBId] ?? ('player:' . $playerBId);

            if ($keyA === $keyB) {
                throw new \RuntimeException(sprintf(
                    'ELO identity collision in match %d: both sides resolve to %s.',
                    (int) $event['match_id'],
                    $keyA
                ));
            }

            $aliases[$keyA][$playerAId] = true;
            $aliases[$keyB][$playerBId] = true;
            $state[$keyA] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];
            $state[$keyB] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];

            $calc = $this->calculator->calculate(
                $state[$keyA]['rating'],
                $state[$keyB]['rating'],
                $state[$keyA]['played'],
                $state[$keyB]['played'],
                (float) $event['score_a']
            );

            $eventId = (int) $event['id'];
            $this->updateEventCalculation($eventId, $calc);
            $state[$keyA] = [
                'rating' => $calc['rating_a_after'],
                'played' => $calc['matches_after_a'],
                'last_event_id' => $eventId,
            ];
            $state[$keyB] = [
                'rating' => $calc['rating_b_after'],
                'played' => $calc['matches_after_b'],
                'last_event_id' => $eventId,
            ];
            $timeline[] = ['event' => $event, 'calc' => $calc];
        }

        $rawState = [];
        foreach ($aliases as $identityKey => $playerIds) {
            if (!isset($state[$identityKey])) {
                continue;
            }
            foreach (array_keys($playerIds) as $playerId) {
                $rawState[(int) $playerId] = $state[$identityKey];
            }
        }

        $this->replaceCurrentRatings($seasonId, $rawState);
        $this->replaceLedgerSnapshots($seasonId, $timeline);
    }

    /** @return array<int, array<string, mixed>> */
    private function listAppliedEvents(int $seasonId): array
    {
        $sql = sprintf(
            'SELECT e.*,
                    t.start_at AS tournament_start_at,
                    m.round_label, m.round_number, m.bracket_label, m.tournament_group_id,
                    COALESCE(m.finished_at, m.starts_at, t.start_at, m.created_at, e.applied_at) AS occurred_at,
                    pa.display_name AS player_a_name, pa.member_id AS player_a_member_id,
                    pb.display_name AS player_b_name, pb.member_id AS player_b_member_id,
                    CASE
                        WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, ""))="group" THEN 0
                        WHEN pn.id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, "")) IN ("single_elimination","playoff","knockout") THEN 2
                        ELSE 1
                    END AS phase_order,
                    CASE
                        WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label, ""))="group"
                            THEN COALESCE(m.round_number, 32767)
                        WHEN pn.id IS NOT NULL
                            THEN COALESCE(pn.round_number, m.round_number, 32767)
                        ELSE COALESCE(m.round_number, 32767)
                    END AS logical_round,
                    COALESCE(tg.sort_order, 0) AS group_order,
                    COALESCE(pn.position, 0) AS playoff_position
             FROM `%1$selo_match_events` e
             INNER JOIN `%1$smatches` m ON m.id=e.match_id
             INNER JOIN `%1$stournaments` t ON t.id=e.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=e.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=e.player_b_id
             LEFT JOIN `%1$stournament_groups` tg ON tg.id=m.tournament_group_id
             LEFT JOIN `%1$stournament_playoff_nodes` pn ON pn.match_id=m.id
             WHERE e.season_id=? AND e.status="applied"
             ORDER BY COALESCE(t.start_at, m.created_at, e.applied_at) ASC,
                      t.id ASC,
                      phase_order ASC,
                      logical_round ASC,
                      group_order ASC,
                      playoff_position ASC,
                      occurred_at ASC,
                      m.id ASC,
                      e.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $seasonId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /**
     * Resolve duplicate player rows into one ELO identity without merging two known members
     * who happen to share a display name. A null-member alias is attached to a name group only
     * when that group has zero or exactly one known member id.
     *
     * @param array<int,array<string,mixed>> $events
     * @return array<int,string>
     */
    private function buildIdentityMap(array $events): array
    {
        $groups = [];
        foreach ($events as $event) {
            foreach (['a', 'b'] as $side) {
                $playerId = (int) $event['player_' . $side . '_id'];
                $memberValue = $event['player_' . $side . '_member_id'] ?? null;
                $memberId = $memberValue !== null ? (int) $memberValue : null;
                $name = mb_strtolower(trim((string) ($event['player_' . $side . '_name'] ?? '')), 'UTF-8');
                $clubId = (int) ($event['club_id'] ?? 0);
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
    }

    /** @param array<string, mixed> $calc */
    private function updateEventCalculation(int $eventId, array $calc): void
    {
        $sql = sprintf(
            'UPDATE `%1$selo_match_events`
             SET rating_a_before=?, rating_b_before=?, rating_a_after=?, rating_b_after=?,
                 delta_a=?, delta_b=?, matches_before_a=?, matches_before_b=?, k_a=?, k_b=?, updated_at=NOW()
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param(
            'ddddddiiddi',
            $calc['rating_a_before'],
            $calc['rating_b_before'],
            $calc['rating_a_after'],
            $calc['rating_b_after'],
            $calc['delta_a'],
            $calc['delta_b'],
            $calc['matches_before_a'],
            $calc['matches_before_b'],
            $calc['k_a'],
            $calc['k_b'],
            $eventId
        );
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<int, array{rating:float,played:int,last_event_id:?int}> $state */
    private function replaceCurrentRatings(int $seasonId, array $state): void
    {
        $delete = $this->connection->prepare(sprintf(
            'DELETE FROM `%1$selo_current_ratings` WHERE season_id=?',
            $this->tablePrefix
        ));
        $delete->bind_param('i', $seasonId);
        $delete->execute();
        $delete->close();

        if ($state === []) {
            return;
        }

        $sql = sprintf(
            'INSERT INTO `%1$selo_current_ratings` (season_id, player_id, rating, matches_played, last_event_id)
             VALUES (?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        ksort($state);
        foreach ($state as $playerId => $row) {
            $rating = (float) $row['rating'];
            $played = (int) $row['played'];
            $lastEventId = $row['last_event_id'] !== null ? (int) $row['last_event_id'] : null;
            $stmt->bind_param('iidii', $seasonId, $playerId, $rating, $played, $lastEventId);
            $stmt->execute();
        }
        $stmt->close();
    }

    /** @param array<int, array{event:array<string,mixed>,calc:array<string,mixed>}> $timeline */
    private function replaceLedgerSnapshots(int $seasonId, array $timeline): void
    {
        $deleteSql = sprintf(
            'DELETE FROM `%1$sranking_snapshots`
             WHERE season_id=? AND ranking_type="elo"
               AND JSON_UNQUOTE(JSON_EXTRACT(context_json, "$.source"))="elo_ledger"',
            $this->tablePrefix
        );
        $delete = $this->connection->prepare($deleteSql);
        $delete->bind_param('i', $seasonId);
        $delete->execute();
        $delete->close();

        if ($timeline === []) {
            return;
        }

        $insertSql = sprintf(
            'INSERT INTO `%1$sranking_snapshots`
             (season_id, tournament_id, player_id, ranking_type, scope_type, points, position, context_json, calculated_at)
             VALUES (?, ?, ?, "elo", "season", ?, NULL, ?, ?)',
            $this->tablePrefix
        );
        $insert = $this->connection->prepare($insertSql);

        foreach ($timeline as $entry) {
            $event = $entry['event'];
            $calc = $entry['calc'];
            $eventId = (int) $event['id'];
            $tournamentId = (int) $event['tournament_id'];
            $matchId = (int) $event['match_id'];
            $calculatedAt = substr((string) ($event['occurred_at'] ?? $event['applied_at']), 0, 19);

            foreach ([
                [
                    'player_id' => (int) $event['player_a_id'],
                    'points' => (float) $calc['rating_a_after'],
                    'delta' => (float) $calc['delta_a'],
                    'before' => (float) $calc['rating_a_before'],
                    'matches_before' => (int) $calc['matches_before_a'],
                    'matches_after' => (int) $calc['matches_after_a'],
                    'k' => (float) $calc['k_a'],
                ],
                [
                    'player_id' => (int) $event['player_b_id'],
                    'points' => (float) $calc['rating_b_after'],
                    'delta' => (float) $calc['delta_b'],
                    'before' => (float) $calc['rating_b_before'],
                    'matches_before' => (int) $calc['matches_before_b'],
                    'matches_after' => (int) $calc['matches_after_b'],
                    'k' => (float) $calc['k_b'],
                ],
            ] as $player) {
                $playerId = $player['player_id'];
                $points = $player['points'];
                $context = json_encode([
                    'source' => 'elo_ledger',
                    'event_id' => $eventId,
                    'match_id' => $matchId,
                    'rating_before' => $player['before'],
                    'rating_after' => $points,
                    'delta' => $player['delta'],
                    'matches_before' => $player['matches_before'],
                    'matches_after' => $player['matches_after'],
                    'k' => $player['k'],
                    'phase_order' => (int) ($event['phase_order'] ?? 1),
                    'logical_round' => (int) ($event['logical_round'] ?? 0),
                ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $insert->bind_param('iiidss', $seasonId, $tournamentId, $playerId, $points, $context, $calculatedAt);
                $insert->execute();
            }
        }
        $insert->close();
    }

    /** @return array<string, mixed>|null */
    private function findMatch(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.status, m.player_a_id, m.player_b_id, m.winner_player_id,
                    t.club_id, t.season_id, t.start_at, t.elo_enabled
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function lockSeason(int $seasonId): void
    {
        $sql = sprintf('SELECT id FROM `%1$sseasons` WHERE id=? FOR UPDATE', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $seasonId);
        $stmt->execute();
        $stmt->get_result()->fetch_assoc();
        $stmt->close();
    }
}
