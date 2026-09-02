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

        $participantIds = $this->participantIds($tournamentId);
        $eventStarts = $this->eventStartState($tournamentId);

        $insert = $this->connection->prepare(sprintf(
            'INSERT IGNORE INTO `%1$stournament_elo_snapshots`
             (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
             VALUES (?,?,?,?,?,?,?,?,?)',
            $this->tablePrefix
        ));
        $tournamentStartAt = trim((string) ($tournament['start_at'] ?? '')) !== ''
            ? substr((string) $tournament['start_at'], 0, 19)
            : date('Y-m-d H:i:s');

        // The rank baseline belongs to the entire club list, not just players in
        // the tournament. That is what lets a non-participant show ▼1 when a
        // tournament player passes them during the evening.
        if ($initialBatch) {
            $baselineKind = 'start';
            foreach ($rankingRows as $row) {
                $playerId = (int) ($row['id'] ?? 0);
                if ($playerId <= 0 || isset($existing[$playerId])) {
                    continue;
                }
                $eventStart = $eventStarts[$playerId] ?? null;
                $before = is_array($eventStart)
                    ? (float) $eventStart['elo_before']
                    : (float) ($row['elo_rating'] ?? 1000.0);
                $matchesBefore = is_array($eventStart)
                    ? (int) $eventStart['matches_before']
                    : (int) ($row['elo_matches_played'] ?? 0);
                $rankBefore = is_array($eventStart) ? null : (int) ($row['position'] ?? 0);
                if ($rankBefore !== null && $rankBefore <= 0) {
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
                    $tournamentStartAt
                );
                $insert->execute();
                $existing[$playerId] = true;
            }
        }

        // Participants with no ranked club row still need a snapshot. On the
        // first batch they belong to the start baseline. A player first seen
        // later gets an entry baseline and can show NY until they move.
        foreach (array_keys($participantIds) as $playerId) {
            if (isset($existing[$playerId])) {
                continue;
            }
            $rankRow = $rankingByPlayer[$playerId] ?? null;
            $eventStart = $eventStarts[$playerId] ?? null;
            if (is_array($eventStart)) {
                $before = (float) $eventStart['elo_before'];
                $matchesBefore = (int) $eventStart['matches_before'];
                $rankBefore = null;
            } elseif (is_array($rankRow)) {
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
            $baselineKind = $initialBatch ? 'start' : 'entry';
            $capturedAt = $initialBatch ? $tournamentStartAt : date('Y-m-d H:i:s');
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
            $existing[$playerId] = true;
        }
        $insert->close();

        // Self-heal tournaments that already had participant-only snapshots from
        // the first rank implementation. Participant ratings are rolled back to
        // elo_before before the full club start order is reconstructed.
        $snapshots = $this->listTournamentSnapshots($tournamentId);
        $this->ensureClubStartBaselines($tournamentId, $rankingRows, $snapshots);
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
        if (!$completed) {
            $this->captureStart($tournamentId);
        }

        $snapshots = $this->listTournamentSnapshots($tournamentId);
        if ($snapshots === []) {
            return $rows;
        }

        if ($this->ensureClubStartBaselines($tournamentId, $rows, $snapshots)) {
            $snapshots = $this->listTournamentSnapshots($tournamentId);
        }

        [$byPlayer, $byName] = $this->snapshotIndexes($snapshots);
        $participants = $this->participantIds($tournamentId);

        foreach ($rows as &$row) {
            $snapshot = $this->snapshotForRow($row, $byPlayer, $byName);
            if (!is_array($snapshot)) {
                $row['tournament_elo_before'] = null;
                $row['tournament_elo_after'] = null;
                $row['tournament_elo_delta'] = null;
                $row['tournament_elo_participant'] = false;
                $row['tournament_rank_before'] = null;
                $row['tournament_rank_after'] = null;
                $row['tournament_rank_delta'] = null;
                $row['tournament_rank_baseline_kind'] = null;
                $row['tournament_rank_is_new'] = false;
                continue;
            }

            $snapshotPlayerId = (int) $snapshot['player_id'];
            $isParticipant = isset($participants[$snapshotPlayerId]);
            $before = (float) $snapshot['elo_before'];
            $after = $snapshot['elo_after'] !== null ? (float) $snapshot['elo_after'] : null;
            $displayRating = $completed && $after !== null ? $after : (float) ($row['elo_rating'] ?? $before);
            $row['elo_rating'] = $displayRating;
            $row['tournament_elo_before'] = $before;
            $row['tournament_elo_after'] = $after;
            $row['tournament_elo_participant'] = $isParticipant;
            // A spectator can move in rank because someone passes them, but they
            // did not gain/lose ELO in this tournament. Keep the ELO delta badge
            // reserved for actual tournament participants.
            $row['tournament_elo_delta'] = $isParticipant ? $displayRating - $before : null;
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
                $row['tournament_rank_delta'] = null;
                $row['tournament_rank_is_new'] = true;
                continue;
            }
            $rankDelta = (int) $beforeRank - $currentRank;
            $row['tournament_rank_delta'] = $rankDelta;
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
        $rowByPlayer = [];
        $rankByName = [];
        $rowByName = [];
        foreach ($rankingRows as $row) {
            $playerId = (int) ($row['id'] ?? 0);
            $rank = (int) ($row['position'] ?? 0);
            if ($playerId > 0) {
                $rowByPlayer[$playerId] = $row;
                if ($rank > 0) {
                    $rankByPlayer[$playerId] = $rank;
                }
            }
            $key = mb_strtolower(trim((string) ($row['display_name'] ?? '')), 'UTF-8');
            if ($key !== '') {
                if (!array_key_exists($key, $rowByName)) {
                    $rowByName[$key] = $row;
                    $rankByName[$key] = $rank > 0 ? $rank : null;
                } else {
                    $rowByName[$key] = null;
                    $rankByName[$key] = null;
                }
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
            $current = $rowByPlayer[$playerId] ?? null;
            $rankAfter = $rankByPlayer[$playerId] ?? null;
            if (!is_array($current)) {
                $key = mb_strtolower(trim((string) ($snapshot['display_name'] ?? '')), 'UTF-8');
                $current = $key !== '' ? ($rowByName[$key] ?? null) : null;
                $rankAfter = $key !== '' ? ($rankByName[$key] ?? null) : null;
            }

            if (is_array($event)) {
                $after = (float) $event['elo_after'];
                $matchesAfter = (int) $event['matches_after'];
            } elseif (is_array($current)) {
                $after = (float) ($current['elo_rating'] ?? $snapshot['elo_before']);
                $matchesAfter = (int) ($current['elo_matches_played'] ?? $snapshot['matches_before']);
            } else {
                $after = (float) $snapshot['elo_before'];
                $matchesAfter = (int) $snapshot['matches_before'];
            }

            $update->bind_param('diisii', $after, $rankAfter, $matchesAfter, $capturedEndAt, $tournamentId, $playerId);
            $update->execute();
        }
        $update->close();
    }

    /**
     * Ensures that rank_before describes the full club ranking at tournament
     * start. This also repairs participant-only snapshots created by v1.
     *
     * @param array<int,array<string,mixed>> $rows Current full club ELO rows.
     * @param array<int,array<string,mixed>> $snapshots
     */
    private function ensureClubStartBaselines(int $tournamentId, array $rows, array $snapshots): bool
    {
        if ($rows === [] || $snapshots === []) {
            return false;
        }
        $tournament = $this->tournament($tournamentId);
        if ($tournament === null || $tournament['season_id'] === null) {
            return false;
        }

        [$byPlayer, $byName] = $this->snapshotIndexes($snapshots);
        $baselineRows = [];
        $missingRows = [];

        foreach ($rows as $row) {
            $snapshot = $this->snapshotForRow($row, $byPlayer, $byName);
            if (is_array($snapshot) && (string) ($snapshot['rank_baseline_kind'] ?? 'start') === 'entry') {
                // An unranked/new late entrant was not part of the start list.
                continue;
            }

            $candidate = $row;
            if (is_array($snapshot)) {
                $candidate['elo_rating'] = (float) $snapshot['elo_before'];
                $candidate['elo_matches_played'] = (int) $snapshot['matches_before'];
                $candidate['_snapshot_player_id'] = (int) $snapshot['player_id'];
            } else {
                $candidate['_snapshot_player_id'] = (int) ($row['id'] ?? 0);
                $missingRows[(int) ($row['id'] ?? 0)] = $row;
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

        $rankByPlayer = [];
        foreach ($baselineRows as $index => $row) {
            $playerId = (int) ($row['_snapshot_player_id'] ?? 0);
            if ($playerId > 0) {
                $rankByPlayer[$playerId] = $index + 1;
            }
        }
        if ($rankByPlayer === []) {
            return false;
        }

        $changed = false;
        $seasonId = (int) $tournament['season_id'];
        $clubId = (int) $tournament['club_id'];
        $baselineKind = 'start';
        $capturedAt = trim((string) ($tournament['start_at'] ?? '')) !== ''
            ? substr((string) $tournament['start_at'], 0, 19)
            : date('Y-m-d H:i:s');

        if ($missingRows !== []) {
            $insert = $this->connection->prepare(sprintf(
                'INSERT IGNORE INTO `%1$stournament_elo_snapshots`
                 (tournament_id,season_id,club_id,player_id,elo_before,matches_before,rank_before,rank_baseline_kind,captured_start_at)
                 VALUES (?,?,?,?,?,?,?,?,?)',
                $this->tablePrefix
            ));
            foreach ($missingRows as $playerId => $row) {
                if ($playerId <= 0 || !isset($rankByPlayer[$playerId])) {
                    continue;
                }
                $before = (float) ($row['elo_rating'] ?? 1000.0);
                $matchesBefore = (int) ($row['elo_matches_played'] ?? 0);
                $rankBefore = (int) $rankByPlayer[$playerId];
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
                $changed = $changed || $insert->affected_rows > 0;
            }
            $insert->close();
        }

        // Recalculate all start ranks, not only NULL values. This intentionally
        // fixes an incorrect old baseline that could produce ▲1 with no actual
        // place change.
        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_elo_snapshots`
             SET rank_before=?
             WHERE tournament_id=? AND player_id=? AND rank_baseline_kind="start"
               AND (rank_before IS NULL OR rank_before<>?)',
            $this->tablePrefix
        ));
        foreach ($snapshots as $snapshot) {
            if ((string) ($snapshot['rank_baseline_kind'] ?? 'start') !== 'start') {
                continue;
            }
            $playerId = (int) $snapshot['player_id'];
            $rank = $rankByPlayer[$playerId] ?? null;
            if ($rank === null) {
                continue;
            }
            $update->bind_param('iiii', $rank, $tournamentId, $playerId, $rank);
            $update->execute();
            $changed = $changed || $update->affected_rows > 0;
        }
        $update->close();
        return $changed;
    }

    /** @return array<int,bool> */
    private function participantIds(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT player_id FROM `%1$stournament_players`
             WHERE tournament_id=? AND status NOT IN ("withdrawn","no_show")',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $ids = [];
        foreach ($rows as $row) {
            $playerId = (int) ($row['player_id'] ?? 0);
            if ($playerId > 0) {
                $ids[$playerId] = true;
            }
        }
        return $ids;
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

    /** @return array<int,array{elo_before:float,matches_before:int}> */
    private function eventStartState(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT player_a_id,rating_a_before,matches_before_a,
                    player_b_id,rating_b_before,matches_before_b
             FROM `%1$selo_match_events`
             WHERE tournament_id=? AND status="applied"
               AND rating_a_before IS NOT NULL AND rating_b_before IS NOT NULL',
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
                if (!isset($state[$playerId]) || $matchesBefore < $state[$playerId]['matches_before']) {
                    $state[$playerId] = [
                        'matches_before' => $matchesBefore,
                        'elo_before' => (float) $row['rating_' . $side . '_before'],
                    ];
                }
            }
        }
        return $state;
    }

    /** @return array<int,array{elo_after:float,matches_after:int,matches_before:int}> */
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
