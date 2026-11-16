<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Service\EloCalculator;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Club ELO calculation independent of season_id. Existing canonical seasonal
 * ELO events/snapshots are never overwritten; this is a read-only projection
 * of actual finished matches in the selected club ELO period.
 *
 * Both participants must resolve to canonical members. Match order follows
 * the canonical tournament/phase/round ordering, not ingestion timestamps.
 */
final class ClubEloReadRepository
{
    private mysqli $db;
    private string $prefix;
    private EloCalculator $calculator;
    private ClubEloPeriodRepository $periods;

    public function __construct(Database $database)
    {
        $this->db = $database->connection();
        $this->prefix = $database->tablePrefix();
        $this->calculator = new EloCalculator();
        $this->periods = new ClubEloPeriodRepository($database);
    }

    /** @return array{period:array<string,mixed>|null,items:list<array<string,mixed>>} */
    public function clubRanking(int $clubId): array
    {
        $period = $this->periods->current($clubId);
        if ($period === null) return ['period' => null, 'items' => []];
        $timeline = $this->replay($clubId, $period);
        $rows = $this->playerRows($clubId);
        $chosen = [];
        foreach ($rows as $row) {
            $memberId = (int) ($row['effective_member_id'] ?? 0);
            if ($memberId <= 0 || !isset($timeline['ratings'][$memberId])) continue;
            $rating = $timeline['ratings'][$memberId];
            if ($rating['played'] < 1) continue;

            $key = (string) $memberId;
            $item = [
                'id' => (int) $row['id'],
                'display_name' => (string) $row['display_name'],
                'nickname' => $row['nickname'],
                'avatar_url' => $row['avatar_url'],
                'elo_rating' => $rating['rating'],
                'elo_matches_played' => $rating['played'],
                'matches_played' => $rating['played'],
                'baseline_played' => $rating['played'],
                'elo_source' => 'club_elo_period',
                'elo_period_id' => (int) $period['id'],
            ];
            // A member may have several historical player aliases; only
            // expose one row per canonical member identity.
            if (!isset($chosen[$key]) || (int) $row['is_active'] > (int) $chosen[$key]['is_active']) {
                $item['is_active'] = (int) $row['is_active'];
                $chosen[$key] = $item;
            }
        }
        $items = array_values($chosen);
        foreach ($items as &$item) unset($item['is_active']);
        unset($item);
        usort($items, static function (array $a, array $b): int {
            $byRating = $b['elo_rating'] <=> $a['elo_rating'];
            return $byRating ?: strcasecmp($a['display_name'], $b['display_name']);
        });
        foreach ($items as $index => &$item) $item['position'] = $index + 1;
        unset($item);
        return ['period' => $period, 'items' => $items];
    }

    /** @return array{period:array<string,mixed>,items:list<array<string,mixed>>,player_id:int}|null */
    public function playerTournaments(int $playerId, ?int $periodId = null): ?array
    {
        $player = $this->player($playerId);
        if ($player === null) return null;
        $clubId = (int) $player['club_id'];
        if ($periodId !== null) {
            $period = $this->periods->find($periodId);
            if ($period === null || (int) $period['club_id'] !== $clubId) {
                throw new ValidationException('elo_period_not_found', 'ELO-perioden finnes ikke i denne klubben.', 404);
            }
        } else {
            $period = $this->periods->current($clubId);
            if ($period === null) {
                $all = $this->periods->listForClub($clubId);
                $period = $all[0] ?? null;
            }
        }
        if ($period === null) return ['period' => [], 'items' => [], 'player_id' => $playerId];
        $memberId = (int) ($player['effective_member_id'] ?? 0);
        $replay = $this->replay($clubId, $period);
        $snapshots = $replay['tournaments'][$memberId] ?? [];
        $lastRating = 1000.0;
        $lastPlayed = 0;
        $events = [];
        foreach ($this->eligibleTournaments($clubId, $period) as $tournament) {
            $id = (int) $tournament['id'];
            $snapshot = $snapshots[$id] ?? null;
            $before = $snapshot['before'] ?? $lastRating;
            $after = $snapshot['after'] ?? $lastRating;
            $count = (int) ($snapshot['matches'] ?? 0);
            $lastRating = $after;
            $lastPlayed += $count;
            $events[] = [
                'tournament_id' => $id,
                'elo_period_id' => (int) $period['id'],
                'season_id' => $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null,
                'tournament_name' => $tournament['name'],
                'tournament_status' => $tournament['status'],
                'start_at' => $tournament['start_at'],
                'end_at' => $tournament['end_at'],
                'rating_before' => $before,
                'rating_after' => $after,
                'matches_after' => $lastPlayed,
                'tournament_matches' => $count,
                'delta' => $after - $before,
                'completed' => true,
                'played_elo' => $count > 0,
                'has_snapshot' => $snapshot !== null,
            ];
        }
        return ['period' => $period, 'items' => $events, 'player_id' => $playerId];
    }

    /** @return array{ratings:array<int,array{rating:float,played:int}>,tournaments:array<int,array<int,array{before:float,after:float,matches:int}>>} */
    private function replay(int $clubId, array $period): array
    {
        $start = $period['starts_on'] . ' 00:00:00';
        $end = $period['ends_on'] === null ? null : $period['ends_on'] . ' 23:59:59';
        $sql = sprintf(
            'SELECT m.id,m.player_a_id,m.player_b_id,m.winner_player_id,m.tournament_id,
                    t.start_at,t.name AS tournament_name,
                    COALESCE(pa.member_id,(
                        SELECT CASE WHEN COUNT(DISTINCT pa2.member_id)=1 THEN MIN(pa2.member_id) ELSE NULL END
                          FROM `%1$splayers` pa2
                         WHERE pa2.club_id=t.club_id AND COALESCE(pa2.member_id,0)>0
                           AND LOWER(TRIM(pa2.display_name))=LOWER(TRIM(pa.display_name))
                    )) AS member_a_id,
                    COALESCE(pb.member_id,(
                        SELECT CASE WHEN COUNT(DISTINCT pb2.member_id)=1 THEN MIN(pb2.member_id) ELSE NULL END
                          FROM `%1$splayers` pb2
                         WHERE pb2.club_id=t.club_id AND COALESCE(pb2.member_id,0)>0
                           AND LOWER(TRIM(pb2.display_name))=LOWER(TRIM(pb.display_name))
                    )) AS member_b_id,
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
                    COALESCE(m.finished_at,m.starts_at,t.start_at,m.created_at) AS occurred_at
               FROM `%1$smatches` m
               INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
               INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
               INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
               LEFT JOIN `%1$stournament_groups` tg ON tg.id=m.tournament_group_id
               LEFT JOIN `%1$stournament_playoff_nodes` pn ON pn.match_id=m.id
              WHERE t.club_id=? AND t.elo_enabled=1 AND m.status="completed"
                AND t.start_at>=? AND (? IS NULL OR t.start_at<=?)
              ORDER BY COALESCE(t.start_at,m.created_at) ASC,t.id ASC,
                       phase_order ASC,logical_round ASC,group_order ASC,playoff_position ASC,
                       occurred_at ASC,m.id ASC', $this->prefix
        );
        $stmt = $this->db->prepare($sql);
        $stmt->bind_param('isss', $clubId, $start, $end, $end);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $ratings = [];
        $tournaments = [];
        foreach ($rows as $m) {
            $a = (int) ($m['member_a_id'] ?? 0);
            $b = (int) ($m['member_b_id'] ?? 0);
            if ($a < 1 || $b < 1 || $a === $b) continue;
            $aBefore = $ratings[$a] ?? ['rating' => 1000.0, 'played' => 0];
            $bBefore = $ratings[$b] ?? ['rating' => 1000.0, 'played' => 0];
            $winner = (int) ($m['winner_player_id'] ?? 0);
            $scoreA = $winner === 0 ? 0.5 : ($winner === (int) $m['player_a_id'] ? 1.0 : 0.0);
            $calc = $this->calculator->calculate(
                $aBefore['rating'], $bBefore['rating'], $aBefore['played'], $bBefore['played'], $scoreA
            );
            $ratings[$a] = ['rating' => $calc['rating_a_after'], 'played' => $calc['matches_after_a']];
            $ratings[$b] = ['rating' => $calc['rating_b_after'], 'played' => $calc['matches_after_b']];
            $tournamentId = (int) $m['tournament_id'];
            foreach ([[$a, $aBefore['rating'], $calc['rating_a_after']],
                      [$b, $bBefore['rating'], $calc['rating_b_after']]] as [$memberId, $before, $after]) {
                if (!isset($tournaments[$memberId][$tournamentId])) {
                    $tournaments[$memberId][$tournamentId] = ['before' => $before, 'after' => $after, 'matches' => 0];
                }
                $tournaments[$memberId][$tournamentId]['after'] = $after;
                ++$tournaments[$memberId][$tournamentId]['matches'];
            }
        }
        return ['ratings' => $ratings, 'tournaments' => $tournaments];
    }

    /** @return list<array<string,mixed>> */
    private function eligibleTournaments(int $clubId, array $period): array
    {
        $start = $period['starts_on'] . ' 00:00:00';
        $end = $period['ends_on'] === null ? null : $period['ends_on'] . ' 23:59:59';
        $stmt = $this->db->prepare(sprintf(
            'SELECT id,season_id,name,status,start_at,end_at
             FROM `%1$stournaments`
             WHERE club_id=? AND elo_enabled=1 AND status="completed"
               AND start_at>=? AND (? IS NULL OR start_at<=?)
             ORDER BY start_at ASC,id ASC', $this->prefix
        ));
        $stmt->bind_param('isss', $clubId, $start, $end, $end);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return list<array<string,mixed>> */
    private function playerRows(int $clubId): array
    {
        $stmt = $this->db->prepare(sprintf(
            'SELECT p.id,p.club_id,p.display_name,p.nickname,p.avatar_url,p.is_active,
                    COALESCE(p.member_id,(
                        SELECT CASE WHEN COUNT(DISTINCT p2.member_id)=1 THEN MIN(p2.member_id) ELSE NULL END
                        FROM `%1$splayers` p2
                        WHERE p2.club_id=p.club_id AND COALESCE(p2.member_id,0)>0
                          AND LOWER(TRIM(p2.display_name))=LOWER(TRIM(p.display_name))
                    )) AS effective_member_id
             FROM `%1$splayers` p WHERE p.club_id=?', $this->prefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<string,mixed>|null */
    private function player(int $playerId): ?array
    {
        $stmt = $this->db->prepare(sprintf(
            'SELECT p.id,p.club_id,p.display_name,
                    COALESCE(p.member_id,(
                        SELECT CASE WHEN COUNT(DISTINCT p2.member_id)=1 THEN MIN(p2.member_id) ELSE NULL END
                        FROM `%1$splayers` p2
                        WHERE p2.club_id=p.club_id AND COALESCE(p2.member_id,0)>0
                          AND LOWER(TRIM(p2.display_name))=LOWER(TRIM(p.display_name))
                    )) AS effective_member_id
             FROM `%1$splayers` p WHERE p.id=? LIMIT 1', $this->prefix
        ));
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }
}
