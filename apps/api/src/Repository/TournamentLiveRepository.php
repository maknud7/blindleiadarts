<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class TournamentLiveRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private TournamentOperationsRepository $operations;
    private PlayerPortalRepository $portal;
    private EloReadRepository $elo;
    private TournamentPlayoffRepository $playoffs;
    private TournamentEloSnapshotRepository $tournamentElo;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->operations = new TournamentOperationsRepository($database);
        $this->portal = new PlayerPortalRepository($database);
        $this->elo = new EloReadRepository($database);
        $this->playoffs = new TournamentPlayoffRepository($database, null, $this->portal);
        $this->tournamentElo = new TournamentEloSnapshotRepository($database);
    }

    /** @return array<string,mixed>|null */
    public function byClubSlug(string $clubSlug): ?array
    {
        $sql = sprintf(
            'SELECT t.id
             FROM `%1$stournaments` t
             INNER JOIN `%1$sclubs` c ON c.id=t.club_id
             WHERE c.slug=? AND t.status IN ("in_progress","ready","completed")
             ORDER BY FIELD(t.status,"in_progress","ready","completed"),
                      CASE WHEN t.status="completed" THEN COALESCE(t.end_at,t.start_at) END DESC,
                      CASE WHEN t.status<>"completed" THEN COALESCE(t.start_at,"2999-12-31 23:59:59") END ASC,
                      t.id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('s', $clubSlug);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row === null ? null : $this->byTournamentId((int) $row['id']);
    }

    /** @return array<string,mixed>|null */
    public function byTournamentId(int $tournamentId): ?array
    {
        $tournament = $this->operations->findTournament($tournamentId);
        if ($tournament === null) {
            return null;
        }

        $ops = $this->operations->snapshot($tournamentId);
        $boards = [];
        foreach ((array) ($ops['boards'] ?? []) as $board) {
            $board['live_match'] = $board['active_match_id'] !== null
                ? $this->liveMatch((int) $board['active_match_id'])
                : null;
            $boards[] = $board;
        }

        $queueItems = array_values(array_filter(
            (array) ($ops['queue']['items'] ?? []),
            static fn (array $match): bool => (string) ($match['status'] ?? '') === 'pending'
        ));

        $eloRows = $this->elo->listClubElo((int) $tournament['club_id']);
        $eloRows = $this->tournamentElo->decorateLiveRows(
            $tournamentId,
            $eloRows,
            (string) ($tournament['status'] ?? '') === 'completed'
        );

        return [
            'club' => [
                'id' => (int) $tournament['club_id'],
                'name' => $tournament['club_name'],
                'slug' => $tournament['club_slug'],
            ],
            'tournament' => $tournament,
            'progress' => $ops['progress'],
            'boards' => $boards,
            'next_matches' => array_slice($queueItems, 0, 10),
            'recent_results' => $ops['recent_results'],
            'qualifiers_per_group' => $this->qualifiersPerGroup($tournamentId),
            'tables' => $this->portal->getTournamentTables($tournamentId),
            'playoff' => $this->playoffWithScores($tournamentId),
            'elo' => $eloRows,
            'highlights' => $this->highlights($tournamentId),
            'updated_at' => date('c'),
        ];
    }

    /** @return array<string,mixed>|null */
    private function playoffWithScores(int $tournamentId): ?array
    {
        $bracket = $this->playoffs->getBracket($tournamentId);
        if ($bracket === null) {
            return null;
        }

        foreach ($bracket['rounds'] as &$round) {
            foreach ($round['nodes'] as &$node) {
                $node['legs_a'] = 0;
                $node['legs_b'] = 0;
                $matchId = (int) ($node['match_id'] ?? 0);
                $playerA = (int) ($node['player_a_id'] ?? 0);
                $playerB = (int) ($node['player_b_id'] ?? 0);
                if ($matchId <= 0 || $playerA <= 0 || $playerB <= 0) {
                    continue;
                }
                $wins = $this->legWins($matchId, $playerA, $playerB);
                $node['legs_a'] = (int) ($wins[$playerA] ?? 0);
                $node['legs_b'] = (int) ($wins[$playerB] ?? 0);
            }
            unset($node);
        }
        unset($round);

        return $bracket;
    }

    /** @return array<string,mixed>|null */
    private function liveMatch(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.status, m.round_label, m.bracket_label, m.best_of_legs, m.legs_to_win,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    l.id AS leg_id, l.leg_number, l.starting_player_id, l.start_score
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$slegs` l ON l.id=(
                SELECT l2.id FROM `%1$slegs` l2
                WHERE l2.match_id=m.id AND l2.status IN ("pending","in_progress")
                ORDER BY l2.leg_number DESC LIMIT 1
             )
             WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($match === null) {
            return null;
        }

        $a = (int) $match['player_a_id'];
        $b = (int) $match['player_b_id'];
        $legs = $this->legWins($matchId, $a, $b);
        $start = (int) ($match['start_score'] ?? 501);
        $remaining = [$a => $start, $b => $start];
        $currentPlayerId = null;

        if ($match['leg_id'] !== null) {
            $legId = (int) $match['leg_id'];
            $visitSql = sprintf(
                'SELECT player_id, score, is_bust FROM `%1$svisits` WHERE leg_id=? ORDER BY id ASC',
                $this->tablePrefix
            );
            $visits = $this->connection->prepare($visitSql);
            $visits->bind_param('i', $legId);
            $visits->execute();
            $result = $visits->get_result();
            $count = 0;
            while ($row = $result->fetch_assoc()) {
                $count++;
                if ((int) $row['is_bust'] === 0) {
                    $playerId = (int) $row['player_id'];
                    $remaining[$playerId] = ($remaining[$playerId] ?? $start) - (int) $row['score'];
                }
            }
            $visits->close();
            $starter = (int) ($match['starting_player_id'] ?? $a);
            $other = $starter === $a ? $b : $a;
            $currentPlayerId = $count % 2 === 0 ? $starter : $other;
        }

        return [
            'id' => (int) $match['id'],
            'status' => $match['status'],
            'round_label' => $match['round_label'],
            'bracket_label' => $match['bracket_label'],
            'best_of_legs' => (int) $match['best_of_legs'],
            'leg_number' => $match['leg_number'] !== null ? (int) $match['leg_number'] : null,
            'current_player_id' => $currentPlayerId,
            'player_a' => [
                'id' => $a,
                'display_name' => $match['player_a_name'],
                'remaining' => $remaining[$a],
                'legs_won' => $legs[$a],
            ],
            'player_b' => [
                'id' => $b,
                'display_name' => $match['player_b_name'],
                'remaining' => $remaining[$b],
                'legs_won' => $legs[$b],
            ],
        ];
    }

    /** @return array<int,int> */
    private function legWins(int $matchId, int $a, int $b): array
    {
        $counts = [$a => 0, $b => 0];
        $stmt = $this->connection->prepare(sprintf(
            'SELECT winner_player_id, COUNT(*) AS c FROM `%1$slegs`
             WHERE match_id=? AND status="completed" AND winner_player_id IS NOT NULL
             GROUP BY winner_player_id',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            $counts[(int) $row['winner_player_id']] = (int) $row['c'];
        }
        $stmt->close();
        return $counts;
    }

    private function qualifiersPerGroup(int $tournamentId): ?int
    {
        $sql = sprintf(
            'SELECT COALESCE(po.qualifiers_per_group, t.planned_qualifiers_per_group) AS qualifiers_per_group
             FROM `%1$stournaments` t
             LEFT JOIN `%1$stournament_playoffs` po ON po.tournament_id=t.id
             WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null || $row['qualifiers_per_group'] === null) {
            return null;
        }
        return max(0, (int) $row['qualifiers_per_group']);
    }

    /** @return array<string,mixed> */
    private function highlights(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT
                COALESCE(MAX(ms.highest_checkout),0) AS highest_checkout,
                COALESCE(SUM(ms.score_180),0) AS score_180,
                COALESCE(MAX(ms.average),0) AS best_average
             FROM `%1$smatch_statistics` ms
             INNER JOIN `%1$smatches` m ON m.id=ms.match_id
             WHERE m.tournament_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return [
            'highest_checkout' => (int) ($row['highest_checkout'] ?? 0),
            'score_180' => (int) ($row['score_180'] ?? 0),
            'best_average' => round((float) ($row['best_average'] ?? 0), 2),
        ];
    }
}
