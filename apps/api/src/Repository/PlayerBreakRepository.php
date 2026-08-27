<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class PlayerBreakRepository
{
    public const BREAK_MINUTES = 7;

    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed> */
    public function requestBreak(int $tournamentId, int $playerId): array
    {
        $this->normalizeTournament($tournamentId);
        $existing = $this->currentBreak($tournamentId, $playerId);
        if ($existing !== null && in_array((string) $existing['status'], ['scheduled', 'active'], true)) {
            return $existing;
        }

        $this->assertEligible($tournamentId, $playerId);
        $match = $this->activeMatch($tournamentId, $playerId);
        if ($match !== null) {
            $status = 'scheduled';
            $afterMatchId = (int) $match['id'];
            $sql = sprintf(
                'INSERT INTO `%1$stournament_player_breaks`
                 (tournament_id, player_id, after_match_id, status, requested_at)
                 VALUES (?, ?, ?, ?, NOW())',
                $this->tablePrefix
            );
            $stmt = $this->connection->prepare($sql);
            $stmt->bind_param('iiis', $tournamentId, $playerId, $afterMatchId, $status);
            $stmt->execute();
            $stmt->close();
        } else {
            $status = 'active';
            $sql = sprintf(
                'INSERT INTO `%1$stournament_player_breaks`
                 (tournament_id, player_id, status, requested_at, starts_at, ends_at)
                 VALUES (?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL %2$d MINUTE))',
                $this->tablePrefix,
                self::BREAK_MINUTES
            );
            $stmt = $this->connection->prepare($sql);
            $stmt->bind_param('iis', $tournamentId, $playerId, $status);
            $stmt->execute();
            $stmt->close();
        }

        $this->setRegistrationPaused($tournamentId, $playerId);
        return $this->currentBreak($tournamentId, $playerId) ?? [];
    }

    /** @return array<string,mixed>|null */
    public function getStatus(int $tournamentId, int $playerId): ?array
    {
        $this->normalizeTournament($tournamentId);
        return $this->currentBreak($tournamentId, $playerId);
    }

    /** @return array<string,mixed>|null */
    public function findContext(int $playerId): ?array
    {
        $this->normalizeAll();
        $sql = sprintf(
            'SELECT t.id AS tournament_id, t.name AS tournament_name, t.status AS tournament_status,
                    t.start_at, t.end_at, tp.status AS registration_status
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$stournaments` t ON t.id=tp.tournament_id
             WHERE tp.player_id=?
               AND tp.status IN ("checked_in","paused")
               AND t.status IN ("ready","in_progress")
             ORDER BY FIELD(t.status,"in_progress","ready"), COALESCE(t.start_at,"2999-12-31 23:59:59") ASC, t.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $row = null;
        foreach ($rows as $candidate) {
            $candidateTournamentId = (int) ($candidate['tournament_id'] ?? 0);
            if ($candidateTournamentId > 0 && $this->isTournamentLiveNow($candidateTournamentId, $playerId)) {
                $row = $candidate;
                break;
            }
        }

        if ($row === null) {
            return null;
        }
        $tournamentId = (int) $row['tournament_id'];
        $row['tournament_id'] = $tournamentId;
        $row['break_minutes'] = self::BREAK_MINUTES;
        $row['break'] = $this->currentBreak($tournamentId, $playerId);
        $row['match'] = $this->activeMatch($tournamentId, $playerId);
        return $row;
    }

    public function normalizeAll(): void
    {
        $sql = sprintf(
            'SELECT DISTINCT tournament_id
             FROM `%1$stournament_player_breaks`
             WHERE status IN ("scheduled","active")',
            $this->tablePrefix
        );
        $result = $this->connection->query($sql);
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        foreach ($rows as $row) {
            $this->normalizeTournament((int) $row['tournament_id']);
        }
    }

    /** @return array<int,array<string,mixed>> */
    public function listCurrentBreaks(int $tournamentId): array
    {
        $this->normalizeTournament($tournamentId);
        $sql = sprintf(
            'SELECT pb.id, pb.player_id, p.display_name, pb.status, pb.after_match_id,
                    pb.requested_at, pb.starts_at, pb.ends_at,
                    CASE WHEN pb.status="active" THEN GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), pb.ends_at)) ELSE NULL END AS remaining_seconds
             FROM `%1$stournament_player_breaks` pb
             INNER JOIN `%1$splayers` p ON p.id=pb.player_id
             WHERE pb.tournament_id=? AND pb.status IN ("scheduled","active")
             ORDER BY FIELD(pb.status,"active","scheduled"), COALESCE(pb.ends_at,"2999-12-31 23:59:59"), pb.id',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $row['remaining_seconds'] = $row['remaining_seconds'] !== null ? (int) $row['remaining_seconds'] : null;
        }
        unset($row);
        return $rows;
    }

    public function normalizeTournament(int $tournamentId): void
    {
        $activateSql = sprintf(
            'UPDATE `%1$stournament_player_breaks` pb
             INNER JOIN `%1$smatches` m ON m.id=pb.after_match_id
             SET pb.starts_at=COALESCE(m.finished_at,NOW()),
                 pb.ends_at=DATE_ADD(COALESCE(m.finished_at,NOW()), INTERVAL %2$d MINUTE),
                 pb.status=CASE
                    WHEN DATE_ADD(COALESCE(m.finished_at,NOW()), INTERVAL %2$d MINUTE)<=NOW() THEN "completed"
                    ELSE "active"
                 END
             WHERE pb.tournament_id=? AND pb.status="scheduled"
               AND m.status IN ("completed","cancelled")',
            $this->tablePrefix,
            self::BREAK_MINUTES
        );
        $activate = $this->connection->prepare($activateSql);
        $activate->bind_param('i', $tournamentId);
        $activate->execute();
        $activate->close();

        $expireSql = sprintf(
            'UPDATE `%1$stournament_player_breaks`
             SET status="completed"
             WHERE tournament_id=? AND status="active" AND ends_at<=NOW()',
            $this->tablePrefix
        );
        $expire = $this->connection->prepare($expireSql);
        $expire->bind_param('i', $tournamentId);
        $expire->execute();
        $expire->close();

        $pauseSql = sprintf(
            'UPDATE `%1$stournament_players` tp
             INNER JOIN `%1$stournament_player_breaks` pb
                ON pb.tournament_id=tp.tournament_id AND pb.player_id=tp.player_id
             SET tp.status="paused"
             WHERE tp.tournament_id=? AND pb.status IN ("scheduled","active")
               AND tp.status IN ("registered","checked_in","paused")',
            $this->tablePrefix
        );
        $pause = $this->connection->prepare($pauseSql);
        $pause->bind_param('i', $tournamentId);
        $pause->execute();
        $pause->close();

        $restoreSql = sprintf(
            'UPDATE `%1$stournament_players` tp
             SET tp.status="checked_in"
             WHERE tp.tournament_id=? AND tp.status="paused"
               AND NOT EXISTS (
                    SELECT 1 FROM `%1$stournament_player_breaks` pb
                    WHERE pb.tournament_id=tp.tournament_id AND pb.player_id=tp.player_id
                      AND pb.status IN ("scheduled","active")
               )',
            $this->tablePrefix
        );
        $restore = $this->connection->prepare($restoreSql);
        $restore->bind_param('i', $tournamentId);
        $restore->execute();
        $restore->close();
    }

    private function setRegistrationPaused(int $tournamentId, int $playerId): void
    {
        $sql = sprintf(
            'UPDATE `%1$stournament_players` SET status="paused"
             WHERE tournament_id=? AND player_id=? AND status="checked_in"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $stmt->close();
    }

    private function assertEligible(int $tournamentId, int $playerId): void
    {
        $sql = sprintf(
            'SELECT t.status AS tournament_status, tp.status AS registration_status
             FROM `%1$stournaments` t
             INNER JOIN `%1$stournament_players` tp ON tp.tournament_id=t.id AND tp.player_id=?
             WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $playerId, $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($row === null) {
            throw new ValidationException('registration_not_found', 'Du er ikke registrert i denne turneringen.', 404);
        }
        if ((string) $row['registration_status'] !== 'checked_in') {
            throw new ValidationException('check_in_required_for_break', 'Du må være checket inn før du kan ta pause.', 409);
        }
        if (!in_array((string) $row['tournament_status'], ['ready', 'in_progress'], true)
            || !$this->isTournamentLiveNow($tournamentId, $playerId)) {
            throw new ValidationException('tournament_not_active_for_break', 'Pause kan bare brukes mens turneringen faktisk pågår nå.', 409);
        }
    }

    private function isTournamentLiveNow(int $tournamentId, int $playerId): bool
    {
        $sql = sprintf(
            'SELECT CASE WHEN
                EXISTS (
                    SELECT 1 FROM `%1$smatches` m
                    WHERE m.tournament_id=t.id
                      AND (m.player_a_id=? OR m.player_b_id=?)
                      AND m.status IN ("assigned","in_progress")
                )
                OR (
                    t.start_at IS NOT NULL
                    AND t.start_at BETWEEN DATE_SUB(NOW(), INTERVAL 18 HOUR) AND DATE_ADD(NOW(), INTERVAL 6 HOUR)
                    AND (t.end_at IS NULL OR t.end_at>=NOW())
                )
                OR (
                    t.start_at IS NOT NULL
                    AND t.start_at<=NOW()
                    AND t.end_at IS NOT NULL
                    AND t.end_at>=NOW()
                )
                THEN 1 ELSE 0 END AS live_now
             FROM `%1$stournaments` t
             WHERE t.id=? AND t.status IN ("ready","in_progress")
             LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $playerId, $playerId, $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return (int) ($row['live_now'] ?? 0) === 1;
    }

    /** @return array<string,mixed>|null */
    private function activeMatch(int $tournamentId, int $playerId): ?array
    {
        $sql = sprintf(
            'SELECT id, status, starts_at, round_label, bracket_label
             FROM `%1$smatches`
             WHERE tournament_id=? AND (player_a_id=? OR player_b_id=?)
               AND status IN ("assigned","in_progress")
             ORDER BY FIELD(status,"in_progress","assigned"), id ASC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $tournamentId, $playerId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string,mixed>|null */
    private function currentBreak(int $tournamentId, int $playerId): ?array
    {
        $sql = sprintf(
            'SELECT pb.id, pb.tournament_id, pb.player_id, pb.after_match_id, pb.status,
                    pb.requested_at, pb.starts_at, pb.ends_at,
                    CASE WHEN pb.status="active" THEN GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), pb.ends_at)) ELSE NULL END AS remaining_seconds,
                    m.status AS after_match_status, m.round_label AS after_match_round
             FROM `%1$stournament_player_breaks` pb
             LEFT JOIN `%1$smatches` m ON m.id=pb.after_match_id
             WHERE pb.tournament_id=? AND pb.player_id=?
             ORDER BY FIELD(pb.status,"active","scheduled","completed"), pb.id DESC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            $row['break_minutes'] = self::BREAK_MINUTES;
            $row['remaining_seconds'] = $row['remaining_seconds'] !== null ? (int) $row['remaining_seconds'] : null;
        }
        return $row;
    }
}
