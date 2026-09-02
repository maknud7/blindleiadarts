<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class TournamentEloSnapshotRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private EloReadRepository $elo;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->elo = new EloReadRepository($database);
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
        $snapshots = $this->listTournamentSnapshots($tournamentId);
        $existing = [];
        foreach ($snapshots as $snapshot) {
            $existing[(int) $snapshot['player_id']] = true;
        }
        $initialBatch = $snapshots === [];

        $rankingRows = $this->elo->listClubElo($clubId);
        $rankingByPlayer = [];
        foreach ($rankingRows as $row) {
            $rankingByPlayer[(int) ($row['id'] ?? 0)] = $row;
        }

        $stmt = $this->connection->prepare(sprintf(
            'SELECT tp.player_id
             FROM `%1$stournament_players` tp
             WHERE tp.tournament_id=? AND tp.status IN ("checked_in","registered","eliminated")
             ORDER BY tp.player_id ASC',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $participants = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        if ($participants === []) {
            return;
        }

        $insert = $this->connection->prepare(sprintf(
            'INSERT IGNORE INTO `%1$stournament_elo_snapshots`
             (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
             VALUES (?,?,?,?,?,?,?,?,?)',
            $this->tablePrefix
        ));
        $baselineKind = $initialBatch ? 'start' : 'entry';
        $capturedAt = $initialBatch && trim((string) ($tournament['start_at'] ?? '')) !== ''
            ? substr((string) $tournament['start_at'], 0, 19)
            : date('Y-m-d H:i:s');

        foreach ($participants as $participant) {
            $playerId = (int) $participant['player_id'];
            if (isset($existing[$playerId])) {
                continue;
            }
            $rankRow = $rankingByPlayer[$playerId] ?? null;
            if (is_array($rankRow)) {
                $before = (float) ($rankRow['elo_rating'] ?? 1000.0);
                $matchesBefore = (int) ($rankRow['elo_matches_played'] ?? 0);
                $rankBefore = (int) ($rankRow['position'] ?? 0);
                if ($rankBefore <= 0) {
                    $rankBefore = null;
                }
            } else {
                $state = $this->currentPlayerState($seasonId, $playerId);
                $before = (float) ($state['rating'] ?? 1000.0);
                $matchesBefore = (int) ($state['matches_played'] ?? 0);
                $rankBefore = null;
            }
            $insert->bind_param(
                'iiiidiiss',
                $tournamentId,
                $seasonId,
                $clubId,
                $playerId,
                $before,
                $matchesBefore,
                $rankBefore,
                $baselineKind,
                $capturedAt
            );
            $insert->execute();
        }
        $insert->close();
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

        // Idempotent. The first batch is the tournament-start baseline; any
        // missing participant discovered later gets an entry baseline instead.
        $this->captureStart($tournamentId);

        if ((string) ($tournament['status'] ?? '') !== 'completed') {
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_elo_snapshots`
                 SET elo_after=NULL,rank_after=NULL,matches_after=NULL,captured_end_at=NULL
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
        // Live polling doubles as a safe self-healing boundary for late entries:
        // it captures a missing participant before decorating the next frame.
        if (!$completed) {
            $this->captureStart($tournamentId);
        }

        $snapshots = $this->listTournamentSnapshots($tournamentId);
        if ($snapshots === []) {
            return $rows;
        }

        // Snapshots created before rank tracking was deployed still have the
        // correct ELO-before value. Reconstruct their start rank once from the
        // current club list with participant ratings rolled back to elo_before.
        if ($this->ensureRankBaselines($tournamentId, $rows, $snapshots)) {
            $snapshots = $this->listTournamentSnapshots($tournamentId);
        }

        [$byPlayer, $byName] = $this->snapshotIndexes($snapshots);

        foreach ($rows as &$row) {
            $snapshot = $this->snapshotForRow($row, $byPlayer, $byName);
            if (!is_array($snapshot)) {
                $row['tournament_elo_before'] = null;
                $row['tournament_elo_after'] = null;
                $row['tournament_elo_delta'] = null;
                $row['tournament_rank_before'] = null;
                $row['tournament_rank_after'] = null;
                $row['tournament_rank_delta'] = null;
                $row['tournament_rank_baseline_kind'] = null;
                $row['tournament_rank_is_new'] = false;
                continue;
            }
            $before = (float) $snapshot['elo_before'];
            $after = $snapshot['elo_after'] !== null ? (float) $snapshot['elo_after'] : null;
            $displayRating = $completed && $after !== null ? $after : (float) ($row['elo_rating'] ?? $before);
            $row['elo_rating'] = $displayRating;
            $row['tournament_elo_before'] = $before;
            $row['tournament_elo_after'] = $after;
            $row['tournament_elo_delta'] = $displayRating - $before;
            $row['tournament_rank_before'] = $snapshot['rank_before'] !== null ? (int) $snapshot['rank_before'] : null;
            $row['tournament_rank_after'] = $snapshot['rank_after'] !== null ? (int) $snapshot['rank_after'] : null;
            $row['tournament_rank_baseline_kind'] = (string) ($snapshot['rank_baseline_kind'] ?? 'start');
            $row['tournament_rank_delta'] = null;
            $row['tournament_rank_is_new'] = false;
        }
        unset($row);

        usort($rows, static function (array $a, array $b): int {
            $rating = ((float) ($b['elo_rating'] ?? 1000)) <=> ((float) ($a['elo_rating'] ?? 1000));
            return $rating !== 0 ? $rating : strcasecmp((string) ($a['display_name'] ?? ''), (string) ($b['display_name'] ?? ''));
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
            if (($row['tournament_rank_baseline_kind'] ?? null) === null) {
                continue;
            }
            $beforeRank = $row['tournament_rank_before'];
            $currentRank = $completed && $row['tournament_rank_after'] !== null
                ? (int) $row['tournament_rank_after']
                : (int) $row['position'];
            if ($beforeRank === null) {
                // No prior ranked position (typically first ELO match).
                $row['tournament_rank_delta'] = null;
                $row['tournament_rank_is_new'] = true;
                continue;
            }
            $rankDelta = (int) $beforeRank - $currentRank;
            $row['tournament_rank_delta'] = $rankDelta;
            // A late entrant starts with NY. Once their rank changes, the arrow
            // takes over and communicates the movement from their entry rank.
            $row['tournament_rank_is_new'] = ($row['tournament_rank_baseline_kind'] === 'entry' && $rankDelta === 0);
        }
        unset($row);
        return $rows;
    }

    private function captureEnd(int $tournamentId, string $endAt): void
    {
        $tournament = $this->tournament($tournamentId);
        if ($tournament === null) {
            return;
        }
        $events = $this->eventEndState($tournamentId);
        $snapshots = $this->listTournamentSnapshots($tournamentId);
        if ($snapshots === []) {
            return;
        }
        $rankingRows = $this->elo->listClubElo((int) $tournament['club_id']);
        $rankByPlayer = [];
        $rankByName = [];
        foreach ($rankingRows as $row) {
            $rank = (int) ($row['position'] ?? 0);
            if ($rank <= 0) {
                continue;
            }
            $rankByPlayer[(int) ($row['id'] ?? 0)] = $rank;
            $key = mb_strtolower(trim((string) ($row['display_name'] ?? '')), 'UTF-8');
            if ($key !== '') {
                $rankByName[$key] = array_key_exists($key, $rankByName) ? null : $rank;
            }
        }

        $capturedEndAt = trim($endAt) !== '' ? substr($endAt, 0, 19) : date('Y-m-d H:i:s');
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_elo_snapshots`
             SET elo_after=?,rank_after=?,matches_after=?,captured_end_at=?
             WHERE tournament_id=? AND player_id=?',
            $this->tablePrefix
        ));
        foreach ($snapshots as $snapshot) {
            $playerId = (int) $snapshot['player_id'];
            $event = $events[$playerId] ?? null;
            $after = is_array($event) ? (float) $event['elo_after'] : (float) $snapshot['elo_before'];
            $matchesAfter = is_array($event) ? (int) $event['matches_after'] : (int) $snapshot['matches_before'];
            $rankAfter = $rankByPlayer[$playerId] ?? null;
            if ($rankAfter === null) {
                $key = mb_strtolower(trim((string) ($snapshot['display_name'] ?? '')), 'UTF-8');
                $rankAfter = $key !== '' ? ($rankByName[$key] ?? null) : null;
            }
            $update->bind_param('diisii', $after, $rankAfter, $matchesAfter, $capturedEndAt, $tournamentId, $playerId);
            $update->execute();
        }
        $update->close();
    }

    /**
     * @param array<int,array<string,mixed>> $rows
     * @param array<int,array<string,mixed>> $snapshots
     */
    private function ensureRankBaselines(int $tournamentId, array $rows, array $snapshots): bool
    {
        $needsRank = false;
        foreach ($snapshots as $snapshot) {
            if ($snapshot['rank_before'] === null && (int) ($snapshot['matches_before'] ?? 0) > 0) {
                $needsRank = true;
                break;
            }
        }
        if (!$needsRank || $rows === []) {
            return false;
        }

        [$byPlayer, $byName] = $this->snapshotIndexes($snapshots);
        $baselineRows = [];
        foreach ($rows as $row) {
            $snapshot = $this->snapshotForRow($row, $byPlayer, $byName);
            $candidate = $row;
            if (is_array($snapshot)) {
                $candidate['elo_rating'] = (float) $snapshot['elo_before'];
                $candidate['elo_matches_played'] = (int) $snapshot['matches_before'];
                $candidate['_snapshot_player_id'] = (int) $snapshot['player_id'];
            } else {
                $candidate['_snapshot_player_id'] = 0;
            }
            if ((int) ($candidate['elo_matches_played'] ?? 0) <= 0) {
                continue;
            }
            $baselineRows[] = $candidate;
        }
        usort($baselineRows, static function (array $a, array $b): int {
            $rating = ((float) ($b['elo_rating'] ?? 1000)) <=> ((float) ($a['elo_rating'] ?? 1000));
            return $rating !== 0 ? $rating : strcasecmp((string) ($a['display_name'] ?? ''), (string) ($b['display_name'] ?? ''));
        });

        $rankBySnapshotPlayer = [];
        foreach ($baselineRows as $index => $row) {
            $snapshotPlayerId = (int) ($row['_snapshot_player_id'] ?? 0);
            if ($snapshotPlayerId > 0) {
                $rankBySnapshotPlayer[$snapshotPlayerId] = $index + 1;
            }
        }
        if ($rankBySnapshotPlayer === []) {
            return false;
        }

        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_elo_snapshots`
             SET rank_before=?
             WHERE tournament_id=? AND player_id=? AND rank_before IS NULL',
            $this->tablePrefix
        ));
        $changed = false;
        foreach ($snapshots as $snapshot) {
            if ($snapshot['rank_before'] !== null) {
                continue;
            }
            $playerId = (int) $snapshot['player_id'];
            $rank = $rankBySnapshotPlayer[$playerId] ?? null;
            if ($rank === null) {
                continue;
            }
            $update->bind_param('iii', $rank, $tournamentId, $playerId);
            $update->execute();
            $changed = $changed || $update->affected_rows > 0;
        }
        $update->close();
        return $changed;
    }

    /** @return array{0:array<int,array<string,mixed>>,1:array<string,array<string,mixed>|null>} */
    private function snapshotIndexes(array $snapshots): array
    {
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
        return [$byPlayer, $byName];
    }

    /** @return array<string,mixed>|null */
    private function snapshotForRow(array $row, array $byPlayer, array $byName): ?array
    {
        $snapshot = $byPlayer[(int) ($row['id'] ?? 0)] ?? null;
        if ($snapshot === null) {
            $nameKey = mb_strtolower(trim((string) ($row['display_name'] ?? '')), 'UTF-8');
            $snapshot = $nameKey !== '' ? ($byName[$nameKey] ?? null) : null;
        }
        return is_array($snapshot) ? $snapshot : null;
    }

    /** @return array<string,mixed>|null */
    private function currentPlayerState(int $seasonId, int $playerId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT rating,matches_played FROM `%1$selo_current_ratings`
             WHERE season_id=? AND player_id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $seasonId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
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