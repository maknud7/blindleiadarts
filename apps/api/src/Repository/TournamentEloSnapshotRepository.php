<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class TournamentEloSnapshotRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    public function captureStart(int $tournamentId): void
    {
        $tournament = $this->tournament($tournamentId);
        if ($tournament === null
            || (int) ($tournament['elo_enabled'] ?? 0) !== 1
            || $tournament['season_id'] === null) {
            return;
        }

        $seasonId = (int) $tournament['season_id'];
        $clubId = (int) $tournament['club_id'];
        $sql = sprintf(
            'INSERT IGNORE INTO `%1$stournament_elo_snapshots`
             (tournament_id,season_id,club_id,player_id,elo_before,matches_before,captured_start_at)
             SELECT tp.tournament_id, ?, ?, tp.player_id,
                    COALESCE(ecr.rating,1000), COALESCE(ecr.matches_played,0), COALESCE(t.start_at,NOW())
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$stournaments` t ON t.id=tp.tournament_id
             LEFT JOIN `%1$selo_current_ratings` ecr ON ecr.season_id=? AND ecr.player_id=tp.player_id
             WHERE tp.tournament_id=? AND tp.status IN ("checked_in","registered","eliminated")',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiii', $seasonId, $clubId, $seasonId, $tournamentId);
        $stmt->execute();
        $stmt->close();
    }

    public function syncByMatchId(?int $matchId): void
    {
        if ($matchId === null || $matchId <= 0) {
            return;
        }
        $stmt = $this->connection->prepare(sprintf(
            'SELECT tournament_id FROM `%1$smatches` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            return;
        }
        $this->syncTournament((int) $row['tournament_id']);
    }

    public function syncTournament(int $tournamentId): void
    {
        $tournament = $this->tournament($tournamentId);
        if ($tournament === null
            || (int) ($tournament['elo_enabled'] ?? 0) !== 1
            || $tournament['season_id'] === null) {
            return;
        }

        // captureStart is idempotent and also protects tournaments that were
        // already running when this feature was deployed.
        $this->captureStart($tournamentId);

        if ((string) ($tournament['status'] ?? '') !== 'completed') {
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_elo_snapshots`
                 SET elo_after=NULL,matches_after=NULL,captured_end_at=NULL
                 WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();
            return;
        }

        $this->captureEnd($tournamentId, (string) ($tournament['end_at'] ?? ''));
    }

    /** @param array<int,array<string,mixed>> $rows @return array<int,array<string,mixed>> */
    public function decorateLiveRows(int $tournamentId, array $rows, bool $completed): array
    {
        $snapshots = $this->listTournamentSnapshots($tournamentId);
        if ($snapshots === []) {
            return $rows;
        }
        $byPlayer = [];
        $byName = [];
        foreach ($snapshots as $snapshot) {
            $playerId = (int) $snapshot['player_id'];
            $byPlayer[$playerId] = $snapshot;
            $nameKey = mb_strtolower(trim((string) ($snapshot['display_name'] ?? '')), 'UTF-8');
            if ($nameKey !== '') {
                if (!array_key_exists($nameKey, $byName)) {
                    $byName[$nameKey] = $snapshot;
                } else {
                    $byName[$nameKey] = null;
                }
            }
        }

        foreach ($rows as &$row) {
            $snapshot = $byPlayer[(int) ($row['id'] ?? 0)] ?? null;
            if ($snapshot === null) {
                $nameKey = mb_strtolower(trim((string) ($row['display_name'] ?? '')), 'UTF-8');
                $snapshot = $nameKey !== '' ? ($byName[$nameKey] ?? null) : null;
            }
            if (!is_array($snapshot)) {
                $row['tournament_elo_before'] = null;
                $row['tournament_elo_after'] = null;
                $row['tournament_elo_delta'] = null;
                continue;
            }
            $before = (float) $snapshot['elo_before'];
            $after = $snapshot['elo_after'] !== null ? (float) $snapshot['elo_after'] : null;
            $displayRating = $completed && $after !== null ? $after : (float) ($row['elo_rating'] ?? $before);
            $row['elo_rating'] = $displayRating;
            $row['tournament_elo_before'] = $before;
            $row['tournament_elo_after'] = $after;
            $row['tournament_elo_delta'] = $displayRating - $before;
        }
        unset($row);

        usort($rows, static function (array $a, array $b): int {
            $rating = ((float) ($b['elo_rating'] ?? 1000)) <=> ((float) ($a['elo_rating'] ?? 1000));
            return $rating !== 0 ? $rating : strcasecmp((string) ($a['display_name'] ?? ''), (string) ($b['display_name'] ?? ''));
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);
        return $rows;
    }

    private function captureEnd(int $tournamentId, string $endAt): void
    {
        $events = $this->eventEndState($tournamentId);
        $snapshots = $this->listTournamentSnapshots($tournamentId);
        if ($snapshots === []) {
            return;
        }
        $capturedEndAt = trim($endAt) !== '' ? substr($endAt, 0, 19) : date('Y-m-d H:i:s');
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_elo_snapshots`
             SET elo_after=?,matches_after=?,captured_end_at=?
             WHERE tournament_id=? AND player_id=?',
            $this->tablePrefix
        ));
        foreach ($snapshots as $snapshot) {
            $playerId = (int) $snapshot['player_id'];
            $event = $events[$playerId] ?? null;
            $after = is_array($event) ? (float) $event['elo_after'] : (float) $snapshot['elo_before'];
            $matchesAfter = is_array($event) ? (int) $event['matches_after'] : (int) $snapshot['matches_before'];
            $update->bind_param('disii', $after, $matchesAfter, $capturedEndAt, $tournamentId, $playerId);
            $update->execute();
        }
        $update->close();
    }

    /** @return array<int,array<string,mixed>> */
    private function listTournamentSnapshots(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT s.*,p.display_name
             FROM `%1$stournament_elo_snapshots` s
             INNER JOIN `%1$splayers` p ON p.id=s.player_id
             WHERE s.tournament_id=? ORDER BY p.display_name ASC,p.id ASC',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<int,array{elo_after:float,matches_after:int}> */
    private function eventEndState(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT player_a_id,rating_a_after,matches_before_a,
                    player_b_id,rating_b_after,matches_before_b
             FROM `%1$selo_match_events`
             WHERE tournament_id=? AND status="applied"
               AND rating_a_after IS NOT NULL AND rating_b_after IS NOT NULL',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $state = [];
        foreach ($rows as $row) {
            foreach (['a', 'b'] as $side) {
                $playerId = (int) $row['player_' . $side . '_id'];
                $matchesBefore = (int) $row['matches_before_' . $side];
                if (!isset($state[$playerId]) || $matchesBefore >= $state[$playerId]['matches_before']) {
                    $state[$playerId] = [
                        'matches_before' => $matchesBefore,
                        'matches_after' => $matchesBefore + 1,
                        'elo_after' => (float) $row['rating_' . $side . '_after'],
                    ];
                }
            }
        }
        return $state;
    }

    /** @return array<string,mixed>|null */
    private function tournament(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,club_id,season_id,status,start_at,end_at,elo_enabled
             FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }
}
