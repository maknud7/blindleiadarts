<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use mysqli_sql_exception;
use Throwable;

final class TournamentMatchEngineRepository
{
    public const RESULT_HOLD_SECONDS = 30;

    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed> */
    public function listBoardSelection(int $tournamentId): array
    {
        $tournament = $this->requireTournament($tournamentId);
        $clubId = (int) $tournament['club_id'];
        $selected = $this->selectedBoardIds($tournamentId);
        $selectionInitialized = $selected !== [];
        $selectedSet = array_fill_keys($selected, true);

        $sql = sprintf(
            'SELECT k.id, k.code, k.name, k.board_number, k.scoring_mode, k.is_active,
                    EXISTS(
                        SELECT 1 FROM `%1$smatches` m
                        WHERE m.kiosk_id=k.id AND m.status IN ("assigned","in_progress")
                    ) AS is_busy,
                    EXISTS(
                        SELECT 1 FROM `%1$stournament_board_reservations` r
                        WHERE r.kiosk_id=k.id
                    ) AS is_reserved
             FROM `%1$skiosks` k
             WHERE k.club_id=?
             ORDER BY k.board_number ASC, k.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            $id = (int) $row['id'];
            $active = (int) $row['is_active'] === 1;
            $row['id'] = $id;
            $row['board_number'] = (int) $row['board_number'];
            $row['is_active'] = $active;
            $row['is_busy'] = (int) $row['is_busy'] === 1;
            $row['is_reserved'] = (int) $row['is_reserved'] === 1;
            $row['selected'] = $selectionInitialized ? isset($selectedSet[$id]) : $active;
            $row['can_remove'] = !$row['is_busy'] && !$row['is_reserved'];
        }
        unset($row);

        return [
            'tournament_id' => $tournamentId,
            'tournament_status' => (string) $tournament['status'],
            'selection_initialized' => $selectionInitialized,
            'boards' => $rows,
            'selected_count' => count(array_filter($rows, static fn (array $row): bool => (bool) $row['selected'])),
        ];
    }

    /** @param array<int,int> $kioskIds @return array<string,mixed> */
    public function updateBoardSelection(int $tournamentId, array $kioskIds): array
    {
        $tournament = $this->requireTournament($tournamentId);
        if (in_array((string) $tournament['status'], ['completed', 'archived'], true)) {
            throw new ValidationException('tournament_boards_locked', 'Skiver kan ikke endres etter at turneringen er avsluttet.', 409);
        }

        $kioskIds = array_values(array_unique(array_filter(array_map('intval', $kioskIds), static fn (int $id): bool => $id > 0)));
        if ($kioskIds === []) {
            throw new ValidationException('tournament_board_required', 'Velg minst én aktiv skive til turneringen.', 422);
        }

        $clubId = (int) $tournament['club_id'];
        $available = $this->clubBoards($clubId);
        $availableById = [];
        foreach ($available as $board) {
            $availableById[(int) $board['id']] = $board;
        }
        foreach ($kioskIds as $kioskId) {
            $board = $availableById[$kioskId] ?? null;
            if ($board === null || (int) $board['is_active'] !== 1) {
                throw new ValidationException('invalid_tournament_board', 'En valgt skive finnes ikke i klubben eller er deaktivert.', 422);
            }
        }

        $current = $this->selectedBoardIds($tournamentId);
        $removed = array_values(array_diff($current, $kioskIds));
        foreach ($removed as $kioskId) {
            if ($this->boardHasOpenTournamentMatch($tournamentId, $kioskId) || $this->reservationForKiosk($kioskId) !== null) {
                $number = (int) ($availableById[$kioskId]['board_number'] ?? 0);
                throw new ValidationException(
                    'tournament_board_in_use',
                    $number > 0 ? "Board {$number} har en aktiv eller reservert kamp og kan ikke fjernes ennå." : 'Skiven har en aktiv eller reservert kamp og kan ikke fjernes ennå.',
                    409
                );
            }
        }

        $this->connection->begin_transaction();
        try {
            $delete = $this->connection->prepare(sprintf(
                'DELETE FROM `%1$stournament_kiosks` WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $delete->bind_param('i', $tournamentId);
            $delete->execute();
            $delete->close();

            $insert = $this->connection->prepare(sprintf(
                'INSERT INTO `%1$stournament_kiosks` (tournament_id, kiosk_id, sort_order) VALUES (?, ?, ?)',
                $this->tablePrefix
            ));
            foreach ($kioskIds as $index => $kioskId) {
                $sortOrder = $index + 1;
                $insert->bind_param('iii', $tournamentId, $kioskId, $sortOrder);
                $insert->execute();
            }
            $insert->close();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->listBoardSelection($tournamentId);
    }

    /** @return array<string,mixed> */
    public function reserveNextForKiosk(int $kioskId): array
    {
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                return $this->reserveNextForKioskAttempt($kioskId);
            } catch (mysqli_sql_exception $error) {
                if ((int) $error->getCode() !== 1062 || $attempt > 0) {
                    throw $error;
                }
            }
        }
        return ['reserved' => false, 'reason' => 'reservation_conflict', 'reservation' => null];
    }

    /** @return array<string,mixed> */
    private function reserveNextForKioskAttempt(int $kioskId): array
    {
        $this->connection->begin_transaction();
        try {
            $board = $this->lockBoard($kioskId);
            if ($board === null || (int) $board['is_active'] !== 1) {
                $this->connection->commit();
                return ['reserved' => false, 'reason' => 'board_unavailable', 'reservation' => null];
            }
            if ($this->activeMatchForKiosk($kioskId) !== null) {
                $this->connection->commit();
                return ['reserved' => false, 'reason' => 'board_busy', 'reservation' => null];
            }
            $existing = $this->reservationForKiosk($kioskId, true);
            if ($existing !== null) {
                $this->connection->commit();
                return ['reserved' => true, 'reason' => null, 'reservation' => $this->formatReservation($existing)];
            }

            $tournament = $this->operationalTournamentForKiosk($kioskId);
            if ($tournament === null || (int) $tournament['auto_assign_enabled'] !== 1) {
                $this->connection->commit();
                return ['reserved' => false, 'reason' => 'no_auto_tournament', 'reservation' => null];
            }

            $candidate = $this->bestCandidate((int) $tournament['id'], (int) $tournament['club_id']);
            if ($candidate === null) {
                $this->connection->commit();
                return ['reserved' => false, 'reason' => 'no_ready_match', 'reservation' => null];
            }

            $sql = sprintf(
                'INSERT INTO `%1$stournament_board_reservations`
                 (tournament_id, kiosk_id, match_id, reserved_at, activates_at)
                 VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL %2$d SECOND))',
                $this->tablePrefix,
                self::RESULT_HOLD_SECONDS
            );
            $stmt = $this->connection->prepare($sql);
            $tournamentId = (int) $tournament['id'];
            $matchId = (int) $candidate['id'];
            $stmt->bind_param('iii', $tournamentId, $kioskId, $matchId);
            $stmt->execute();
            $stmt->close();
            $reservation = $this->reservationForKiosk($kioskId, true);
            $this->connection->commit();

            return ['reserved' => true, 'reason' => null, 'reservation' => $reservation !== null ? $this->formatReservation($reservation) : null];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @return array<string,mixed> */
    public function assignNextToKiosk(int $kioskId): array
    {
        $retryWithoutReservation = false;
        $this->connection->begin_transaction();
        try {
            $board = $this->lockBoard($kioskId);
            if ($board === null || (int) $board['is_active'] !== 1) {
                $this->connection->commit();
                return ['assigned' => false, 'reason' => 'board_unavailable', 'match' => null, 'reservation' => null];
            }
            if ($this->activeMatchForKiosk($kioskId) !== null) {
                $this->connection->commit();
                return ['assigned' => false, 'reason' => 'board_busy', 'match' => null, 'reservation' => null];
            }

            $reservation = $this->reservationForKiosk($kioskId, true);
            if ($reservation !== null) {
                $remaining = max(0, (int) ($reservation['remaining_seconds'] ?? 0));
                if ($remaining > 0) {
                    $this->connection->commit();
                    return [
                        'assigned' => false,
                        'reason' => 'reservation_wait',
                        'match' => null,
                        'reservation' => $this->formatReservation($reservation),
                    ];
                }

                $matchId = (int) $reservation['match_id'];
                $match = $this->pendingMatchById($matchId, true);
                if ($match === null || $this->playersBusyElsewhere(
                    (int) $reservation['club_id'],
                    (int) $reservation['player_a_id'],
                    (int) $reservation['player_b_id'],
                    (int) $reservation['id']
                )) {
                    $this->deleteReservation((int) $reservation['id']);
                    $retryWithoutReservation = true;
                } else {
                    $this->assignPendingMatch($matchId, $kioskId);
                    $this->deleteReservation((int) $reservation['id']);
                    $assigned = $this->matchById($matchId);
                    $this->connection->commit();
                    return ['assigned' => true, 'reason' => null, 'match' => $assigned, 'reservation' => null];
                }
            }

            if (!$retryWithoutReservation) {
                $tournament = $this->operationalTournamentForKiosk($kioskId);
                if ($tournament === null || (int) $tournament['auto_assign_enabled'] !== 1) {
                    $this->connection->commit();
                    return ['assigned' => false, 'reason' => 'no_active_tournament', 'match' => null, 'reservation' => null];
                }
                $candidate = $this->bestCandidate((int) $tournament['id'], (int) $tournament['club_id']);
                if ($candidate === null) {
                    $this->connection->commit();
                    return ['assigned' => false, 'reason' => 'no_ready_match', 'match' => null, 'reservation' => null];
                }
                $matchId = (int) $candidate['id'];
                $this->assignPendingMatch($matchId, $kioskId);
                $assigned = $this->matchById($matchId);
                $this->connection->commit();
                return ['assigned' => true, 'reason' => null, 'match' => $assigned, 'reservation' => null];
            }

            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->assignNextToKiosk($kioskId);
    }

    public function releaseReservationForKiosk(int $kioskId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'DELETE FROM `%1$stournament_board_reservations` WHERE kiosk_id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $stmt->close();
    }

    /** @return array<string,mixed> */
    public function kioskPostMatch(int $kioskId): array
    {
        $active = $this->activeMatchForKiosk($kioskId);
        $reservation = $this->reservationForKiosk($kioskId);
        if ($active !== null) {
            return [
                'active_match' => true,
                'last_completed_match' => null,
                'reservation' => $reservation !== null ? $this->formatReservation($reservation) : null,
                'remaining_seconds' => $reservation !== null ? max(0, (int) $reservation['remaining_seconds']) : 0,
                'result_display_seconds' => self::RESULT_HOLD_SECONDS,
            ];
        }

        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.round_label, m.bracket_label, m.finished_at,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    m.winner_player_id, pw.display_name AS winner_name,
                    SUM(CASE WHEN l.winner_player_id=m.player_a_id THEN 1 ELSE 0 END) AS legs_a,
                    SUM(CASE WHEN l.winner_player_id=m.player_b_id THEN 1 ELSE 0 END) AS legs_b,
                    t.name AS tournament_name,
                    GREATEST(0, %2$d - TIMESTAMPDIFF(SECOND, m.finished_at, NOW())) AS result_remaining_seconds
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$splayers` pw ON pw.id=m.winner_player_id
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id AND l.status="completed"
             WHERE m.kiosk_id=? AND m.status="completed"
               AND m.finished_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
             GROUP BY m.id, m.tournament_id, m.round_label, m.bracket_label, m.finished_at,
                      m.player_a_id, pa.display_name, m.player_b_id, pb.display_name,
                      m.winner_player_id, pw.display_name, t.name
             ORDER BY m.finished_at DESC, m.id DESC LIMIT 1',
            $this->tablePrefix,
            self::RESULT_HOLD_SECONDS
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $last = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($last !== null) {
            foreach (['id','tournament_id','player_a_id','player_b_id','winner_player_id','legs_a','legs_b','result_remaining_seconds'] as $field) {
                $last[$field] = $last[$field] !== null ? (int) $last[$field] : null;
            }
        }

        $remaining = $reservation !== null
            ? max(0, (int) $reservation['remaining_seconds'])
            : max(0, (int) ($last['result_remaining_seconds'] ?? 0));

        return [
            'active_match' => false,
            'last_completed_match' => $last,
            'reservation' => $reservation !== null ? $this->formatReservation($reservation) : null,
            'remaining_seconds' => $remaining,
            'result_display_seconds' => self::RESULT_HOLD_SECONDS,
        ];
    }

    /** @return array<string,mixed> */
    public function assignFreeBoards(int $tournamentId): array
    {
        $selection = $this->listBoardSelection($tournamentId);
        if (($selection['selection_initialized'] ?? false) !== true) {
            $defaults = array_map(
                static fn (array $board): int => (int) $board['id'],
                array_values(array_filter((array) $selection['boards'], static fn (array $board): bool => (bool) $board['selected']))
            );
            $selection = $this->updateBoardSelection($tournamentId, $defaults);
        }

        $items = [];
        $reserved = [];
        foreach ((array) $selection['boards'] as $board) {
            if (!(bool) ($board['selected'] ?? false) || !(bool) ($board['is_active'] ?? false)) {
                continue;
            }
            $kioskId = (int) $board['id'];
            if ($this->activeMatchForKiosk($kioskId) !== null) {
                continue;
            }
            $existingReservation = $this->reservationForKiosk($kioskId);
            if ($existingReservation !== null) {
                $reserved[] = $this->formatReservation($existingReservation);
                continue;
            }
            $result = $this->assignNextToKiosk($kioskId);
            if (($result['assigned'] ?? false) === true && is_array($result['match'] ?? null)) {
                $items[] = [
                    'match_id' => (int) $result['match']['id'],
                    'kiosk_id' => $kioskId,
                    'board_number' => (int) $board['board_number'],
                    'players' => (string) $result['match']['player_a_name'] . ' vs ' . (string) $result['match']['player_b_name'],
                ];
            }
        }
        return [
            'assigned_count' => count($items),
            'reserved_count' => count($reserved),
            'items' => $items,
            'reservations' => $reserved,
        ];
    }

    /** @param array<string,mixed> $snapshot @return array<string,mixed> */
    public function decorateSnapshot(int $tournamentId, array $snapshot): array
    {
        $reservations = $this->reservationsForTournament($tournamentId);
        $byKiosk = [];
        $byMatch = [];
        $reservedPlayers = [];
        foreach ($reservations as $reservation) {
            $formatted = $this->formatReservation($reservation);
            $byKiosk[(int) $reservation['kiosk_id']] = $formatted;
            $byMatch[(int) $reservation['match_id']] = $formatted;
            $reservedPlayers[(int) $reservation['player_a_id']] = true;
            $reservedPlayers[(int) $reservation['player_b_id']] = true;
        }

        foreach ((array) ($snapshot['boards'] ?? []) as $index => $board) {
            $reservation = $byKiosk[(int) ($board['id'] ?? 0)] ?? null;
            $snapshot['boards'][$index]['reservation'] = $reservation;
            $snapshot['boards'][$index]['reserved_match_id'] = $reservation['match_id'] ?? null;
        }

        $ready = 0;
        $blocked = 0;
        foreach ((array) ($snapshot['queue']['items'] ?? []) as $index => $match) {
            $matchId = (int) ($match['id'] ?? 0);
            $reservation = $byMatch[$matchId] ?? null;
            $a = (int) ($match['player_a_id'] ?? 0);
            $b = (int) ($match['player_b_id'] ?? 0);
            $available = (bool) ($match['players_available'] ?? false)
                && !isset($reservedPlayers[$a])
                && !isset($reservedPlayers[$b]);
            $snapshot['queue']['items'][$index]['players_available'] = $available;
            $snapshot['queue']['items'][$index]['reservation'] = $reservation;
            if ((string) ($match['status'] ?? '') === 'pending') {
                if ($reservation !== null) {
                    continue;
                }
                if ((bool) ($match['players_checked_in'] ?? false) && $available) {
                    $ready++;
                } else {
                    $blocked++;
                }
            }
        }
        $snapshot['queue']['ready_count'] = $ready;
        $snapshot['queue']['blocked_count'] = $blocked;
        $snapshot['reservations'] = array_values($byKiosk);
        return $snapshot;
    }

    /** @return array<string,mixed>|null */
    private function bestCandidate(int $tournamentId, int $clubId): ?array
    {
        $busy = array_fill_keys($this->busyPlayerIds($clubId), true);
        $progress = $this->groupProgress($tournamentId);
        $lastFinished = $this->playerLastFinished($tournamentId);

        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.tournament_group_id, m.round_number, m.round_label, m.bracket_label,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    m.created_at, g.sort_order AS group_sort_order,
                    tpa.status AS player_a_registration_status,
                    tpb.status AS player_b_registration_status
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             LEFT JOIN `%1$stournament_groups` g ON g.id=m.tournament_group_id
             LEFT JOIN `%1$stournament_players` tpa ON tpa.tournament_id=m.tournament_id AND tpa.player_id=m.player_a_id
             LEFT JOIN `%1$stournament_players` tpb ON tpb.tournament_id=m.tournament_id AND tpb.player_id=m.player_b_id
             LEFT JOIN `%1$stournament_board_reservations` r ON r.match_id=m.id
             WHERE m.tournament_id=? AND m.status="pending" AND r.id IS NULL
               AND tpa.status="checked_in" AND tpb.status="checked_in"
             ORDER BY m.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $eligible = [];
        $now = time();
        foreach ($rows as $row) {
            $a = (int) $row['player_a_id'];
            $b = (int) $row['player_b_id'];
            if (isset($busy[$a]) || isset($busy[$b])) {
                continue;
            }
            $groupId = $row['tournament_group_id'] !== null ? (int) $row['tournament_group_id'] : 0;
            $lastA = $lastFinished[$a] ?? null;
            $lastB = $lastFinished[$b] ?? null;
            $lastActivity = max((int) ($lastA ?? 0), (int) ($lastB ?? 0));
            $row['_recent_penalty'] = $lastActivity > 0 && ($now - $lastActivity) < 90 ? 1 : 0;
            $row['_group_progress'] = $groupId > 0 ? (float) ($progress[$groupId] ?? 0.0) : 0.0;
            $row['_last_activity'] = $lastActivity;
            $eligible[] = $row;
        }

        usort($eligible, static function (array $a, array $b): int {
            foreach (['_recent_penalty', '_group_progress', '_last_activity'] as $field) {
                $cmp = $a[$field] <=> $b[$field];
                if ($cmp !== 0) {
                    return $cmp;
                }
            }
            $roundCmp = ((int) ($a['round_number'] ?? 9999)) <=> ((int) ($b['round_number'] ?? 9999));
            if ($roundCmp !== 0) {
                return $roundCmp;
            }
            $groupCmp = ((int) ($a['group_sort_order'] ?? 9999)) <=> ((int) ($b['group_sort_order'] ?? 9999));
            if ($groupCmp !== 0) {
                return $groupCmp;
            }
            return ((int) $a['id']) <=> ((int) $b['id']);
        });

        if ($eligible === []) {
            return null;
        }
        $candidate = $eligible[0];
        unset($candidate['_recent_penalty'], $candidate['_group_progress'], $candidate['_last_activity']);
        return $candidate;
    }

    /** @return array<int,int> */
    private function busyPlayerIds(int $clubId): array
    {
        $sql = sprintf(
            'SELECT DISTINCT player_id FROM (
                SELECT m.player_a_id AS player_id
                FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
                WHERE t.club_id=? AND m.status IN ("assigned","in_progress")
                UNION ALL
                SELECT m.player_b_id AS player_id
                FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
                WHERE t.club_id=? AND m.status IN ("assigned","in_progress")
                UNION ALL
                SELECT m.player_a_id AS player_id
                FROM `%1$stournament_board_reservations` r
                INNER JOIN `%1$smatches` m ON m.id=r.match_id
                INNER JOIN `%1$stournaments` t ON t.id=r.tournament_id
                WHERE t.club_id=?
                UNION ALL
                SELECT m.player_b_id AS player_id
                FROM `%1$stournament_board_reservations` r
                INNER JOIN `%1$smatches` m ON m.id=r.match_id
                INNER JOIN `%1$stournaments` t ON t.id=r.tournament_id
                WHERE t.club_id=?
             ) busy',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiii', $clubId, $clubId, $clubId, $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['player_id'], $rows);
    }

    private function playersBusyElsewhere(int $clubId, int $playerA, int $playerB, int $reservationId): bool
    {
        $sql = sprintf(
            'SELECT 1
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             WHERE t.club_id=? AND m.status IN ("assigned","in_progress")
               AND (m.player_a_id IN (?,?) OR m.player_b_id IN (?,?))
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiiii', $clubId, $playerA, $playerB, $playerA, $playerB);
        $stmt->execute();
        $busy = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        if ($busy) {
            return true;
        }

        $sql = sprintf(
            'SELECT 1
             FROM `%1$stournament_board_reservations` r
             INNER JOIN `%1$smatches` m ON m.id=r.match_id
             INNER JOIN `%1$stournaments` t ON t.id=r.tournament_id
             WHERE t.club_id=? AND r.id<>?
               AND (m.player_a_id IN (?,?) OR m.player_b_id IN (?,?))
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiiiii', $clubId, $reservationId, $playerA, $playerB, $playerA, $playerB);
        $stmt->execute();
        $busy = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $busy;
    }

    /** @return array<int,float> */
    private function groupProgress(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT m.tournament_group_id,
                    SUM(CASE
                        WHEN m.status IN ("assigned","in_progress","completed") OR r.id IS NOT NULL THEN 1
                        ELSE 0
                    END) AS dispatched_count,
                    COUNT(*) AS total_count
             FROM `%1$smatches` m
             LEFT JOIN `%1$stournament_board_reservations` r ON r.match_id=m.id
             WHERE m.tournament_id=? AND m.tournament_group_id IS NOT NULL
             GROUP BY m.tournament_group_id',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $result = [];
        foreach ($rows as $row) {
            $total = max(1, (int) $row['total_count']);
            $result[(int) $row['tournament_group_id']] = ((int) $row['dispatched_count']) / $total;
        }
        return $result;
    }

    /** @return array<int,int> */
    private function playerLastFinished(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT player_id, UNIX_TIMESTAMP(MAX(finished_at)) AS last_finished
             FROM (
                SELECT player_a_id AS player_id, finished_at FROM `%1$smatches`
                WHERE tournament_id=? AND status="completed" AND finished_at IS NOT NULL
                UNION ALL
                SELECT player_b_id AS player_id, finished_at FROM `%1$smatches`
                WHERE tournament_id=? AND status="completed" AND finished_at IS NOT NULL
             ) played
             GROUP BY player_id',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $result = [];
        foreach ($rows as $row) {
            $result[(int) $row['player_id']] = (int) $row['last_finished'];
        }
        return $result;
    }

    /** @return array<string,mixed>|null */
    private function reservationForKiosk(int $kioskId, bool $forUpdate = false): ?array
    {
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $sql = sprintf(
            'SELECT r.id, r.tournament_id, r.kiosk_id, r.match_id, r.reserved_at, r.activates_at,
                    GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), r.activates_at)) AS remaining_seconds,
                    t.club_id, t.name AS tournament_name,
                    m.round_label, m.bracket_label, m.best_of_legs,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    k.board_number
             FROM `%1$stournament_board_reservations` r
             INNER JOIN `%1$stournaments` t ON t.id=r.tournament_id
             INNER JOIN `%1$smatches` m ON m.id=r.match_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             INNER JOIN `%1$skiosks` k ON k.id=r.kiosk_id
             WHERE r.kiosk_id=? LIMIT 1%2$s',
            $this->tablePrefix,
            $lock
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<int,array<string,mixed>> */
    private function reservationsForTournament(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT r.id, r.tournament_id, r.kiosk_id, r.match_id, r.reserved_at, r.activates_at,
                    GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), r.activates_at)) AS remaining_seconds,
                    t.club_id, t.name AS tournament_name,
                    m.round_label, m.bracket_label, m.best_of_legs,
                    m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name,
                    k.board_number
             FROM `%1$stournament_board_reservations` r
             INNER JOIN `%1$stournaments` t ON t.id=r.tournament_id
             INNER JOIN `%1$smatches` m ON m.id=r.match_id
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             INNER JOIN `%1$skiosks` k ON k.id=r.kiosk_id
             WHERE r.tournament_id=? ORDER BY k.board_number ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatReservation(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'tournament_id' => (int) $row['tournament_id'],
            'kiosk_id' => (int) $row['kiosk_id'],
            'board_number' => (int) $row['board_number'],
            'match_id' => (int) $row['match_id'],
            'reserved_at' => $row['reserved_at'],
            'activates_at' => $row['activates_at'],
            'remaining_seconds' => max(0, (int) ($row['remaining_seconds'] ?? 0)),
            'round_label' => $row['round_label'],
            'bracket_label' => $row['bracket_label'],
            'best_of_legs' => (int) $row['best_of_legs'],
            'player_a_id' => (int) $row['player_a_id'],
            'player_a_name' => $row['player_a_name'],
            'player_b_id' => (int) $row['player_b_id'],
            'player_b_name' => $row['player_b_name'],
        ];
    }

    /** @return array<string,mixed>|null */
    private function requireTournament(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, name, status, auto_assign_enabled FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }
        return $row;
    }

    /** @return array<int,array<string,mixed>> */
    private function clubBoards(int $clubId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, board_number, name, is_active, scoring_mode FROM `%1$skiosks` WHERE club_id=? ORDER BY board_number, id',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<int,int> */
    private function selectedBoardIds(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT kiosk_id FROM `%1$stournament_kiosks` WHERE tournament_id=? ORDER BY sort_order, kiosk_id',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['kiosk_id'], $rows);
    }

    /** @return array<string,mixed>|null */
    private function lockBoard(int $kioskId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, club_id, board_number, is_active FROM `%1$skiosks` WHERE id=? LIMIT 1 FOR UPDATE',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function operationalTournamentForKiosk(int $kioskId): ?array
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
            'SELECT id, tournament_id, status, player_a_id, player_b_id
             FROM `%1$smatches`
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

    private function boardHasOpenTournamentMatch(int $tournamentId, int $kioskId): bool
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT 1 FROM `%1$smatches` WHERE tournament_id=? AND kiosk_id=? AND status IN ("assigned","in_progress") LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $tournamentId, $kioskId);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    }

    /** @return array<string,mixed>|null */
    private function pendingMatchById(int $matchId, bool $forUpdate): ?array
    {
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id, tournament_id, status, player_a_id, player_b_id FROM `%1$smatches` WHERE id=? AND status="pending" LIMIT 1%2$s',
            $this->tablePrefix,
            $lock
        ));
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function assignPendingMatch(int $matchId, int $kioskId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$smatches`
             SET kiosk_id=?, status="assigned", starts_at=NULL, finished_at=NULL
             WHERE id=? AND status="pending"',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $kioskId, $matchId);
        $stmt->execute();
        if ($stmt->affected_rows !== 1) {
            $stmt->close();
            throw new ValidationException('match_assignment_conflict', 'Kampen kunne ikke tildeles fordi kampstatus ble endret.', 409);
        }
        $stmt->close();
    }

    private function deleteReservation(int $reservationId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'DELETE FROM `%1$stournament_board_reservations` WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $reservationId);
        $stmt->execute();
        $stmt->close();
    }

    /** @return array<string,mixed>|null */
    private function matchById(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT m.id, m.tournament_id, m.kiosk_id, m.status, m.round_label, m.bracket_label,
                    m.best_of_legs, m.player_a_id, pa.display_name AS player_a_name,
                    m.player_b_id, pb.display_name AS player_b_name
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
             WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            foreach (['id','tournament_id','kiosk_id','best_of_legs','player_a_id','player_b_id'] as $field) {
                $row[$field] = $row[$field] !== null ? (int) $row[$field] : null;
            }
        }
        return $row;
    }
}
