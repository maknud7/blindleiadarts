<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;
use Throwable;

/**
 * Deterministically rebuilds ELO from canonical completed matches.
 *
 * True guests are excluded from the ledger entirely. Legacy player aliases without
 * member_id remain eligible only when their normalized name resolves to exactly one
 * member in the same club.
 */
final class EloCanonicalReplayService
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

    /**
     * @return array{completed_matches:int,eligible_matches:int,guest_neutral_matches:int,seasons_rebuilt:int}
     */
    public function replay(): array
    {
        $matches = $this->completedMatches();
        $bySeason = [];
        $guestNeutral = 0;
        foreach ($matches as $match) {
            $seasonId = (int) $match['season_id'];
            if (!$this->eligible($match)) {
                $guestNeutral++;
            }
            $bySeason[$seasonId][] = $match;
        }

        $eligibleCount = 0;
        foreach ($bySeason as $seasonId => $seasonMatches) {
            $eligibleCount += $this->rebuildSeason((int) $seasonId, $seasonMatches);
        }

        return [
            'completed_matches' => count($matches),
            'eligible_matches' => $eligibleCount,
            'guest_neutral_matches' => $guestNeutral,
            'seasons_rebuilt' => count($bySeason),
        ];
    }

    /** @return array<int,array<string,mixed>> */
    private function completedMatches(): array
    {
        $sql = sprintf(
            'SELECT m.id AS match_id, m.tournament_id, t.club_id, t.season_id,
                    m.player_a_id, m.player_b_id, m.winner_player_id,
                    pa.display_name AS player_a_name,
                    COALESCE(pa.member_id, (
                        SELECT CASE WHEN COUNT(DISTINCT pa2.member_id)=1 THEN MIN(pa2.member_id) ELSE NULL END
                        FROM `%1$splayers` pa2
                        WHERE pa2.club_id=t.club_id AND COALESCE(pa2.member_id,0)>0
                          AND LOWER(TRIM(pa2.display_name))=LOWER(TRIM(pa.display_name))
                    )) AS player_a_member_id,
                    pb.display_name AS player_b_name,
                    COALESCE(pb.member_id, (
                        SELECT CASE WHEN COUNT(DISTINCT pb2.member_id)=1 THEN MIN(pb2.member_id) ELSE NULL END
                        FROM `%1$splayers` pb2
                        WHERE pb2.club_id=t.club_id AND COALESCE(pb2.member_id,0)>0
                          AND LOWER(TRIM(pb2.display_name))=LOWER(TRIM(pb.display_name))
                    )) AS player_b_member_id,
                    COALESCE(m.finished_at,m.starts_at,t.start_at,m.created_at) AS occurred_at,
                    CASE
                        WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,""))="group" THEN 0
                        WHEN pn.id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,"")) IN ("single_elimination","playoff","knockout") THEN 2
                        ELSE 1
                    END AS phase_order,
                    CASE
                        WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,""))="group"
                            THEN COALESCE(m.round_number,32767)
                        WHEN pn.id IS NOT NULL THEN COALESCE(pn.round_number,m.round_number,32767)
                        ELSE COALESCE(m.round_number,32767)
                    END AS logical_round,
                    COALESCE(tg.sort_order,0) AS group_order,
                    COALESCE(pn.position,0) AS playoff_position,
                    COALESCE(t.start_at,m.created_at) AS tournament_order_at
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$stournament_groups` tg ON tg.id=m.tournament_group_id
             LEFT JOIN `%1$stournament_playoff_nodes` pn ON pn.match_id=m.id
             WHERE m.status="completed" AND t.elo_enabled=1 AND t.season_id IS NOT NULL
             ORDER BY t.season_id ASC, tournament_order_at ASC, t.id ASC,
                      phase_order ASC, logical_round ASC, group_order ASC,
                      playoff_position ASC, occurred_at ASC, m.id ASC',
            $this->tablePrefix
        );
        return $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
    }

    /**
     * @param array<int,array<string,mixed>> $matches
     * @return int eligible matches replayed
     */
    private function rebuildSeason(int $seasonId, array $matches): int
    {
        $eligible = array_values(array_filter($matches, fn (array $match): bool => $this->eligible($match)));
        $eventsTable = $this->tablePrefix . 'elo_match_events';
        $currentTable = $this->tablePrefix . 'elo_current_ratings';
        $snapshotsTable = $this->tablePrefix . 'ranking_snapshots';

        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare("DELETE FROM `{$currentTable}` WHERE season_id=?");
            $stmt->bind_param('i', $seasonId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare(
                "DELETE FROM `{$snapshotsTable}`
                 WHERE season_id=? AND ranking_type='elo'
                   AND JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.source'))='elo_ledger'"
            );
            $stmt->bind_param('i', $seasonId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare("DELETE FROM `{$eventsTable}` WHERE season_id=?");
            $stmt->bind_param('i', $seasonId);
            $stmt->execute();
            $stmt->close();

            if ($eligible === []) {
                $this->connection->commit();
                return 0;
            }

            $eventInsert = $this->connection->prepare(
                "INSERT INTO `{$eventsTable}`
                 (match_id,tournament_id,season_id,club_id,player_a_id,player_b_id,winner_player_id,
                  score_a,score_b,rating_a_before,rating_b_before,rating_a_after,rating_b_after,
                  delta_a,delta_b,matches_before_a,matches_before_b,k_a,k_b,status,applied_at,reverted_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,NULL)"
            );
            $snapshotInsert = $this->connection->prepare(
                "INSERT INTO `{$snapshotsTable}`
                 (season_id,tournament_id,player_id,ranking_type,scope_type,points,position,context_json,calculated_at)
                 VALUES (?,?,?,'elo','season',?,NULL,?,?)"
            );

            /** @var array<int,array{rating:float,played:int,last_event_id:?int}> $state */
            $state = [];
            /** @var array<int,array<int,true>> $aliases */
            $aliases = [];

            foreach ($eligible as $match) {
                $matchId = (int) $match['match_id'];
                $tournamentId = (int) $match['tournament_id'];
                $clubId = (int) $match['club_id'];
                $playerAId = (int) $match['player_a_id'];
                $playerBId = (int) $match['player_b_id'];
                $memberAId = (int) $match['player_a_member_id'];
                $memberBId = (int) $match['player_b_member_id'];
                if ($memberAId === $memberBId) {
                    throw new RuntimeException("ELO member identity collision in match {$matchId}.");
                }

                $aliases[$memberAId][$playerAId] = true;
                $aliases[$memberBId][$playerBId] = true;
                $state[$memberAId] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];
                $state[$memberBId] ??= ['rating' => 1000.0, 'played' => 0, 'last_event_id' => null];

                $winnerId = $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null;
                if ($winnerId !== null && $winnerId !== $playerAId && $winnerId !== $playerBId) {
                    throw new RuntimeException("ELO winner is not a participant in match {$matchId}.");
                }
                $scoreA = $winnerId === null ? 0.5 : ($winnerId === $playerAId ? 1.0 : 0.0);
                $calc = $this->calculator->calculate(
                    $state[$memberAId]['rating'],
                    $state[$memberBId]['rating'],
                    $state[$memberAId]['played'],
                    $state[$memberBId]['played'],
                    $scoreA
                );
                $scoreB = 1.0 - $scoreA;
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
                    $occurredAt
                );
                $eventInsert->execute();
                $eventId = (int) $eventInsert->insert_id;

                $state[$memberAId] = [
                    'rating' => (float) $calc['rating_a_after'],
                    'played' => (int) $calc['matches_after_a'],
                    'last_event_id' => $eventId,
                ];
                $state[$memberBId] = [
                    'rating' => (float) $calc['rating_b_after'],
                    'played' => (int) $calc['matches_after_b'],
                    'last_event_id' => $eventId,
                ];

                foreach ([
                    [$playerAId, (float) $calc['rating_a_before'], (float) $calc['rating_a_after'], (float) $calc['delta_a'], (int) $calc['matches_before_a'], (int) $calc['matches_after_a'], (float) $calc['k_a']],
                    [$playerBId, (float) $calc['rating_b_before'], (float) $calc['rating_b_after'], (float) $calc['delta_b'], (int) $calc['matches_before_b'], (int) $calc['matches_after_b'], (float) $calc['k_b']],
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
                        'phase_order' => (int) $match['phase_order'],
                        'logical_round' => (int) $match['logical_round'],
                    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    if ($context === false) {
                        throw new RuntimeException('Could not encode ELO snapshot context.');
                    }
                    $points = $after;
                    $snapshotInsert->bind_param('iiidss', $seasonId, $tournamentId, $playerId, $points, $context, $occurredAt);
                    $snapshotInsert->execute();
                }
            }

            $eventInsert->close();
            $snapshotInsert->close();

            $currentInsert = $this->connection->prepare(
                "INSERT INTO `{$currentTable}` (season_id,player_id,rating,matches_played,last_event_id)
                 VALUES (?,?,?,?,?)"
            );
            ksort($aliases);
            foreach ($aliases as $memberId => $playerIds) {
                $memberState = $state[(int) $memberId];
                foreach (array_keys($playerIds) as $playerId) {
                    $rating = (float) $memberState['rating'];
                    $played = (int) $memberState['played'];
                    $lastEventId = $memberState['last_event_id'] !== null ? (int) $memberState['last_event_id'] : null;
                    $currentInsert->bind_param('iidii', $seasonId, $playerId, $rating, $played, $lastEventId);
                    $currentInsert->execute();
                }
            }
            $currentInsert->close();

            $this->connection->commit();
            return count($eligible);
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @param array<string,mixed> $match */
    private function eligible(array $match): bool
    {
        return (int) ($match['player_a_member_id'] ?? 0) > 0
            && (int) ($match['player_b_member_id'] ?? 0) > 0;
    }
}
