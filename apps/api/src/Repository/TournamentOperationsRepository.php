<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class TournamentOperationsRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed>|null */
    public function findTournament(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
                    t.auto_assign_enabled, c.name AS club_name, c.slug AS club_slug
             FROM `%1$stournaments` t
             INNER JOIN `%1$sclubs` c ON c.id=t.club_id
             WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed> */
    public function updateAutoAssignEnabled(int $tournamentId, bool $enabled): array
    {
        if ($this->findTournament($tournamentId) === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }
        $value = $enabled ? 1 : 0;
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments` SET auto_assign_enabled=? WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $value, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->snapshot($tournamentId);
    }

    /** @return array<string,mixed> */
    public function snapshot(int $tournamentId): array
    {
        $tournament = $this->findTournament($tournamentId);
        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $busyPlayers = $this->busyPlayerIds($clubId);
        $boards = $this->boards($tournamentId, $clubId);
        $queue = $this->queue($tournamentId, $busyPlayers);
        $counts = $this->matchCounts($tournamentId);

        $ready = 0;
        $blocked = 0;
        foreach ($queue as $row) {
            if ((string) $row['status'] !== 'pending') {
                continue;
            }
            if ((bool) $row['players_checked_in'] && (bool) $row['players_available']) {
                $ready++;
            } else {
                $blocked++;
            }
        }

        $total = array_sum($counts);
        $completed = $counts['completed'] ?? 0;
        return [
            'tournament' => $tournament,
            'progress' => [
                'total' => $total,
                'completed' => $completed,
                'pending' => $counts['pending'] ?? 0,
                'assigned' => $counts['assigned'] ?? 0,
                'in_progress' => $counts['in_progress'] ?? 0,
                'cancelled' => $counts['cancelled'] ?? 0,
                'percent' => $total > 0 ? round(($completed / $total) * 100, 1) : 0.0,
            ],
            'queue' => [
                'ready_count' => $ready,
                'blocked_count' => $blocked,
                'items' => $queue,
            ],
            'boards' => $boards,
            'recent_results' => $this->recentResults($tournamentId, 8),
            'updated_at' => date('c'),
        ];
    }

    /** @return array<string,mixed> */
    public function reconcileTournament(int $tournamentId): array
    {
        $assigned = [];
        $this->connection->begin_transaction();
        try {
            $tournament = $this->lockTournament($tournamentId);
            if ($tournament === null) {
                throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
            }

            if ((int) ($tournament['auto_assign_enabled'] ?? 0) === 1) {
                $clubId = (int) $tournament['club_id'];
                $busyPlayers = $this->busyPlayerIds($clubId);
                $boards = array_values(array_filter(
                    $this->boards($tournamentId, $clubId),
                    static fn (array $board): bool => (int) $board['is_active'] === 1 && $board['active_match_id'] === null
                ));
                $queue = $this->queue($tournamentId, $busyPlayers);

                foreach ($queue as $match) {
                    if ($boards === [] || (string) $match['status'] !== 'pending') {
                        continue;
                    }
                    $a = (int) $match['player_a_id'];
                    $b = (int) $match['player_b_id'];
                    if (!(bool) $match['players_checked_in'] || in_array($a, $busyPlayers, true) || in_array($b, $busyPlayers, true)) {
                        continue;
                    }
                    $board = array_shift($boards);
                    if ($board === null) {
                        break;
                    }
                    $this->assignMatch((int) $match['id'], (int) $board['id']);
                    $busyPlayers[] = $a;
                    $busyPlayers[] = $b;
                    $assigned[] = [
                        'match_id' => (int) $match['id'],
                        'kiosk_id' => (int) $board['id'],
                        'board_number' => (int) $board['board_number'],
                        'players' => $match['player_a_name'] . ' vs ' . $match['player_b_name'],
                    ];
                }
            }

            $this->updateLifecycle($tournamentId);
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        $snapshot = $this->snapshot($tournamentId);
        $snapshot['assignment'] = ['assigned_count' => count($assigned), 'items' => $assigned];
        return $snapshot;
    }

    /** @return array<string,mixed> */
    public function assignNextToKiosk(int $kioskId): array
    {
        $board = $this->findKiosk($kioskId);
        if ($board === null) {
            throw new ValidationException('kiosk_not_found', 'Kiosk was not found.', 404);
        }
        if ((int) $board['is_active'] !== 1) {
            throw new ValidationException('kiosk_inactive', 'This board is inactive.', 409);
        }
        if ($this->activeMatchForKiosk($kioskId) !== null) {
            return ['assigned' => false, 'reason' => 'board_busy', 'match' => null];
        }

        $tournament = $this->findOperationalTournamentForKiosk($kioskId);
        if ($tournament === null) {
            return ['assigned' => false, 'reason' => 'no_active_tournament', 'match' => null];
        }
        $tournamentId = (int) $tournament['id'];

        $assignedMatch = null;
        $this->connection->begin_transaction();
        try {
            $locked = $this->lockTournament($tournamentId);
            if ($locked === null) {
                throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
            }
            if ((int) ($locked['auto_assign_enabled'] ?? 0) !== 1) {
                $this->connection->commit();
                return ['assigned' => false, 'reason' => 'auto_assign_disabled', 'match' => null];
            }
            if ($this->activeMatchForKiosk($kioskId) !== null) {
                $this->connection->commit();
                return ['assigned' => false, 'reason' => 'board_busy', 'match' => null];
            }

            $clubId = (int) $locked['club_id'];
            $busyPlayers = $this->busyPlayerIds($clubId);
            foreach ($this->queue($tournamentId, $busyPlayers) as $match) {
                if ((string) $match['status'] !== 'pending' || !(bool) $match['players_checked_in']) {
                    continue;
                }
                $a = (int) $match['player_a_id'];
                $b = (int) $match['player_b_id'];
                if (in_array($a, $busyPlayers, true) || in_array($b, $busyPlayers, true)) {
                    continue;
                }
                $this->assignMatch((int) $match['id'], $kioskId);
                $assignedMatch = $this->matchById((int) $match['id']);
                break;
            }

            $this->updateLifecycle($tournamentId);
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return [
            'assigned' => $assignedMatch !== null,
            'reason' => $assignedMatch !== null ? null : 'no_ready_match',
            'match' => $assignedMatch,
            'operations' => $this->snapshot($tournamentId),
        ];
    }

    /** @return array<string,mixed> */
    public function kioskPostMatch(int $kioskId): array
    {
        $active = $this->activeMatchForKiosk($kioskId);
        if ($active !== null) {
            return ['active_match' => true, 'last_completed_match' => null];
        }

        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.round_label, m.bracket_label, m.finished_at,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    m.winner_player_id, pw.display_name AS winner_name,
                    SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) AS legs_a,
                    SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) AS legs_b,
                    t.name AS tournament_name
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$splayers` pw ON pw.id=m.winner_player_id
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id AND l.status="completed"
             WHERE m.kiosk_id=? AND m.status="completed"
               AND m.finished_at >= DATE_SUB(NOW(), INTERVAL 20 MINUTE)
             GROUP BY m.id, m.tournament_id, m.round_label, m.bracket_label, m.finished_at,
                      m.player_a_id, pa.display_name, m.player_b_id, pb.display_name,
                      m.winner_player_id, pw.display_name, t.name
             ORDER BY m.finished_at DESC, m.id DESC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return ['active_match' => false, 'last_completed_match' => $row];
    }

    /** @return array<string,mixed>|null */
    private function lockTournament(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, status, auto_assign_enabled FROM `%1$stournaments` WHERE id=? LIMIT 1 FOR UPDATE',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function findKiosk(int $kioskId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, code, name, board_number, is_active FROM `%1$skiosks` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function findOperationalTournamentForKiosk(int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT t.id, t.club_id, t.status, t.auto_assign_enabled
             FROM `%1$stournament_kiosks` tk
             INNER JOIN `%1$stournaments` t ON t.id=tk.tournament_id
             WHERE tk.kiosk_id=? AND t.status IN ("ready","in_progress")
             ORDER BY FIELD(t.status,"in_progress","ready"), COALESCE(t.start_at,"2999-12-31 23:59:59") ASC, t.id ASC
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function activeMatchForKiosk(int $kioskId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, tournament_id, status FROM `%1$smatches`
             WHERE kiosk_id=? AND status IN ("assigned","in_progress")
             ORDER BY FIELD(status,"in_progress","assigned"), id ASC LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<int,array<string,mixed>> */
    private function boards(int $tournamentId, int $clubId): array
    {
        $sql = sprintf(
            'SELECT k.id, k.code, k.name, k.board_number, k.scoring_mode, k.is_active,
                    m.id AS active_match_id, m.status AS active_match_status,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    m.round_label, m.bracket_label
             FROM `%1$stournament_kiosks` tk
             INNER JOIN `%1$skiosks` k ON k.id=tk.kiosk_id
             LEFT JOIN `%1$smatches` m ON m.id=(
                 SELECT m2.id FROM `%1$smatches` m2
                 INNER JOIN `%1$stournaments` t2 ON t2.id=m2.tournament_id
                 WHERE m2.kiosk_id=k.id AND t2.club_id=? AND m2.status IN ("assigned","in_progress")
                 ORDER BY FIELD(m2.status,"in_progress","assigned"), m2.id ASC LIMIT 1
             )
             LEFT JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             LEFT JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             WHERE tk.tournament_id=?
             ORDER BY tk.sort_order ASC, k.board_number ASC, k.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $clubId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['board_number'] = (int) $row['board_number'];
            $row['is_active'] = (int) $row['is_active'];
            $row['active_match_id'] = $row['active_match_id'] !== null ? (int) $row['active_match_id'] : null;
        }
        unset($row);
        return $rows;
    }

    /** @param array<int,int> $busyPlayers @return array<int,array<string,mixed>> */
    private function queue(int $tournamentId, array $busyPlayers): array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.tournament_group_id, g.name AS group_name, g.sort_order AS group_sort_order,
                    m.round_label, m.round_number, m.bracket_label, m.status, m.best_of_legs,
                    m.player_a_id, pa.display_name AS player_a_name, tpa.status AS player_a_registration_status,
                    m.player_b_id, pb.display_name AS player_b_name, tpb.status AS player_b_registration_status,
                    m.kiosk_id, k.board_number
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$stournament_groups` g ON g.id=m.tournament_group_id
             LEFT JOIN `%1$stournament_players` tpa ON tpa.tournament_id=m.tournament_id AND tpa.player_id=m.player_a_id
             LEFT JOIN `%1$stournament_players` tpb ON tpb.tournament_id=m.tournament_id AND tpb.player_id=m.player_b_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             WHERE m.tournament_id=? AND m.status IN ("pending","assigned","in_progress")
             ORDER BY FIELD(m.status,"in_progress","assigned","pending"),
                      COALESCE(m.round_number,9999) ASC, COALESCE(g.sort_order,9999) ASC, m.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $a = (int) $row['player_a_id'];
            $b = (int) $row['player_b_id'];
            $row['players_checked_in'] = ($row['player_a_registration_status'] ?? '') === 'checked_in'
                && ($row['player_b_registration_status'] ?? '') === 'checked_in';
            $row['players_available'] = !in_array($a, $busyPlayers, true) && !in_array($b, $busyPlayers, true);
        }
        unset($row);
        return $rows;
    }

    /** @return array<int,int> */
    private function busyPlayerIds(int $clubId): array
    {
        $sql = sprintf(
            'SELECT DISTINCT player_id FROM (
                SELECT m.player_a_id AS player_id FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
                WHERE t.club_id=? AND m.status IN ("assigned","in_progress")
                UNION ALL
                SELECT m.player_b_id AS player_id FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
                WHERE t.club_id=? AND m.status IN ("assigned","in_progress")
             ) busy',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $clubId, $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['player_id'], $rows);
    }

    private function assignMatch(int $matchId, int $kioskId): void
    {
        $status = 'assigned';
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$smatches` SET kiosk_id=?, status=?, starts_at=NULL, finished_at=NULL WHERE id=? AND status="pending"',
            $this->tablePrefix
        ));
        $stmt->bind_param('isi', $kioskId, $status, $matchId);
        $stmt->execute();
        $stmt->close();
    }

    private function updateLifecycle(int $tournamentId): void
    {
        $counts = $this->matchCounts($tournamentId);
        $total = array_sum($counts);
        $open = ($counts['pending'] ?? 0) + ($counts['assigned'] ?? 0) + ($counts['in_progress'] ?? 0);
        if ($total > 0 && $open === 0) {
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments` SET status="completed", end_at=COALESCE(end_at,NOW()) WHERE id=? AND status<>"archived"',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();
            return;
        }
        if ($total > 0 && (($counts['assigned'] ?? 0) + ($counts['in_progress'] ?? 0) + ($counts['completed'] ?? 0)) > 0) {
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments` SET status="in_progress" WHERE id=? AND status IN ("draft","ready")',
                $this->tablePrefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $stmt->close();
        }
    }

    /** @return array<string,int> */
    private function matchCounts(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT status, COUNT(*) AS c FROM `%1$smatches` WHERE tournament_id=? GROUP BY status',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $result = $stmt->get_result();
        $counts = ['pending' => 0, 'assigned' => 0, 'in_progress' => 0, 'completed' => 0, 'cancelled' => 0];
        while ($row = $result->fetch_assoc()) {
            $counts[(string) $row['status']] = (int) $row['c'];
        }
        $stmt->close();
        return $counts;
    }

    /** @return array<int,array<string,mixed>> */
    private function recentResults(int $tournamentId, int $limit): array
    {
        $sql = sprintf(
            'SELECT m.id, m.round_label, m.bracket_label, m.finished_at,
                    pa.display_name AS player_a_name, pb.display_name AS player_b_name,
                    pw.display_name AS winner_name, k.board_number,
                    SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) AS legs_a,
                    SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) AS legs_b
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$splayers` pw ON pw.id=m.winner_player_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id AND l.status="completed"
             WHERE m.tournament_id=? AND m.status="completed"
             GROUP BY m.id, m.round_label, m.bracket_label, m.finished_at,
                      pa.display_name, pb.display_name, pw.display_name, k.board_number
             ORDER BY m.finished_at DESC, m.id DESC LIMIT %2$d',
            $this->tablePrefix,
            max(1, min($limit, 30))
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<string,mixed>|null */
    private function matchById(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.status, m.round_label, m.bracket_label, m.best_of_legs,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    m.kiosk_id, k.board_number, k.name AS kiosk_name
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
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
}
