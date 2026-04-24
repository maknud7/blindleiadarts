<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class TournamentRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                t.id,
                t.club_id,
                t.season_id,
                t.name,
                t.slug,
                t.provider_system,
                t.status,
                t.max_visits_per_leg,
                t.start_at,
                t.end_at,
                COUNT(DISTINCT tp.id) AS registration_count,
                COUNT(DISTINCT m.id) AS match_count,
                COUNT(DISTINCT CASE WHEN m.status = "completed" THEN m.id END) AS completed_match_count
             FROM `%1$stournaments` t
             LEFT JOIN `%1$stournament_players` tp ON tp.tournament_id = t.id AND tp.status <> "withdrawn"
             LEFT JOIN `%1$smatches` m ON m.tournament_id = t.id
             WHERE t.club_id = ?
             GROUP BY t.id, t.club_id, t.season_id, t.name, t.slug, t.provider_system, t.status, t.max_visits_per_leg, t.start_at, t.end_at
             ORDER BY COALESCE(t.start_at, "2999-12-31 23:59:59") ASC, t.id DESC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listMatchCallsByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.tournament_id,
                t.name AS tournament_name,
                m.kiosk_id,
                m.round_label,
                m.bracket_label,
                m.status,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                k.code AS kiosk_code,
                k.name AS kiosk_name,
                k.board_number
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE t.club_id = ?
               AND m.status IN ("pending", "assigned", "in_progress")
             ORDER BY FIELD(m.status, "in_progress", "assigned", "pending"), m.id ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findScreenTournamentByClubId(int $clubId): ?array
    {
        $sql = sprintf(
            'SELECT
                t.id,
                t.club_id,
                t.season_id,
                t.name,
                t.slug,
                t.provider_system,
                t.status,
                t.max_visits_per_leg,
                t.start_at,
                t.end_at,
                COUNT(DISTINCT tp.id) AS registration_count,
                COUNT(DISTINCT m.id) AS match_count,
                COUNT(DISTINCT CASE WHEN m.status = "completed" THEN m.id END) AS completed_match_count
             FROM `%1$stournaments` t
             LEFT JOIN `%1$stournament_players` tp ON tp.tournament_id = t.id AND tp.status <> "withdrawn"
             LEFT JOIN `%1$smatches` m ON m.tournament_id = t.id
             WHERE t.club_id = ?
               AND t.status IN ("in_progress", "ready")
             GROUP BY t.id, t.club_id, t.season_id, t.name, t.slug, t.provider_system, t.status, t.max_visits_per_leg, t.start_at, t.end_at
             ORDER BY
                FIELD(t.status, "in_progress", "ready"),
                CASE WHEN t.start_at IS NULL THEN 1 ELSE 0 END ASC,
                t.start_at DESC,
                t.id DESC
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findById(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT
                t.id,
                t.club_id,
                c.name AS club_name,
                t.season_id,
                t.name,
                t.slug,
                t.provider_system,
                t.status,
                t.max_visits_per_leg,
                t.start_at,
                t.end_at
             FROM `%1$stournaments` t
             INNER JOIN `%1$sclubs` c ON c.id = t.club_id
             WHERE t.id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        $tournament = $result->fetch_assoc() ?: null;
        $statement->close();

        if ($tournament === null) {
            return null;
        }

        $tournament['registrations'] = $this->listRegistrations($tournamentId);
        $tournament['matches'] = $this->listMatches($tournamentId);

        return $tournament;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|null
     */
    public function createTournament(int $clubId, array $payload): ?array
    {
        $name = trim((string) ($payload['name'] ?? ''));
        $slug = $this->slugify((string) ($payload['slug'] ?? $name));
        $seasonId = isset($payload['season_id']) ? (int) $payload['season_id'] : $this->findActiveSeasonId($clubId);
        $providerSystem = trim((string) ($payload['provider_system'] ?? 'local'));
        $status = trim((string) ($payload['status'] ?? 'draft'));
        $maxVisitsPerLeg = (int) ($payload['max_visits_per_leg'] ?? 50);
        $startAt = $this->nullableString($payload['start_at'] ?? null);
        $endAt = $this->nullableString($payload['end_at'] ?? null);

        $sql = sprintf(
            'INSERT INTO `%1$stournaments`
             (club_id, season_id, name, slug, provider_system, status, max_visits_per_leg, start_at, end_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iissssiss', $clubId, $seasonId, $name, $slug, $providerSystem, $status, $maxVisitsPerLeg, $startAt, $endAt);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $this->findById($id);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listRegistrations(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT
                tp.id,
                tp.player_id,
                tp.seed,
                tp.status,
                tp.created_at,
                p.display_name,
                p.nickname,
                mp.contact_email,
                mp.contact_phone
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id = tp.player_id
             LEFT JOIN `%1$smember_profiles` mp ON mp.player_id = p.id
             WHERE tp.tournament_id = ?
             ORDER BY tp.created_at ASC, p.display_name ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    public function registerPlayer(int $tournamentId, int $playerId): array
    {
        $selectSql = sprintf(
            'SELECT id, status
             FROM `%1$stournament_players`
             WHERE tournament_id = ? AND player_id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $select = $this->connection->prepare($selectSql);
        $select->bind_param('ii', $tournamentId, $playerId);
        $select->execute();
        $result = $select->get_result();
        $existing = $result->fetch_assoc() ?: null;
        $select->close();

        if ($existing !== null) {
            $status = 'registered';
            $updateSql = sprintf('UPDATE `%1$stournament_players` SET status = ? WHERE id = ?', $this->tablePrefix);
            $update = $this->connection->prepare($updateSql);
            $existingId = (int) $existing['id'];
            $update->bind_param('si', $status, $existingId);
            $update->execute();
            $update->close();
        } else {
            $status = 'registered';
            $insertSql = sprintf(
                'INSERT INTO `%1$stournament_players` (tournament_id, player_id, status)
                 VALUES (?, ?, ?)',
                $this->tablePrefix
            );
            $insert = $this->connection->prepare($insertSql);
            $insert->bind_param('iis', $tournamentId, $playerId, $status);
            $insert->execute();
            $insert->close();
        }

        return [
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'status' => 'registered',
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listMatches(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.kiosk_id,
                m.round_label,
                m.bracket_label,
                m.status,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                m.winner_player_id,
                pw.display_name AS winner_name,
                m.starts_at,
                m.finished_at,
                k.code AS kiosk_code,
                k.name AS kiosk_name,
                k.board_number
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$splayers` pw ON pw.id = m.winner_player_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE m.tournament_id = ?
             ORDER BY FIELD(m.status, "in_progress", "assigned", "pending", "completed", "cancelled"), m.id ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listUpcomingMatchesByTournamentId(int $tournamentId, int $limit = 10): array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.tournament_id,
                m.kiosk_id,
                m.round_label,
                m.bracket_label,
                m.status,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                k.code AS kiosk_code,
                k.name AS kiosk_name,
                k.board_number
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE m.tournament_id = ?
               AND m.status IN ("assigned", "pending")
             ORDER BY FIELD(m.status, "assigned", "pending"), m.id ASC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listScreenRankings(int $tournamentId, ?int $seasonId, string $rankingType, int $limit = 5): array
    {
        $sql = sprintf(
            'SELECT
                p.id,
                p.display_name,
                rs.points,
                rs.position,
                rs.scope_type,
                rs.calculated_at
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id = tp.player_id
             LEFT JOIN `%1$sranking_snapshots` rs ON rs.id = (
                SELECT rs2.id
                FROM `%1$sranking_snapshots` rs2
                WHERE rs2.player_id = tp.player_id
                  AND rs2.ranking_type = ?
                  AND (
                    rs2.tournament_id = ?
                    OR rs2.season_id <=> ?
                  )
                ORDER BY
                    CASE WHEN rs2.tournament_id = ? THEN 0 ELSE 1 END,
                    rs2.calculated_at DESC,
                    rs2.id DESC
                LIMIT 1
             )
             WHERE tp.tournament_id = ?
               AND tp.status <> "withdrawn"
             ORDER BY
                CASE WHEN rs.position IS NULL THEN 1 ELSE 0 END ASC,
                rs.position ASC,
                rs.points DESC,
                p.display_name ASC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('siiii', $rankingType, $tournamentId, $seasonId, $tournamentId, $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listTopVisitsByTournamentId(int $tournamentId, int $limit = 5): array
    {
        $rows = $this->listTopVisits($tournamentId, $limit, true);

        if ($rows !== []) {
            return $rows;
        }

        return $this->listTopVisits($tournamentId, $limit, false);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listBestMatchAveragesByTournamentId(int $tournamentId, int $limit = 5): array
    {
        $sql = sprintf(
            'SELECT
                m.id AS match_id,
                m.round_label,
                m.bracket_label,
                p.id AS player_id,
                p.display_name,
                ROUND(AVG(v.score) * 3, 2) AS three_dart_average,
                ROUND(AVG(v.score), 2) AS visit_average,
                COUNT(v.id) AS visits_logged
             FROM `%1$svisits` v
             INNER JOIN `%1$smatches` m ON m.id = v.match_id
             INNER JOIN `%1$splayers` p ON p.id = v.player_id
             WHERE m.tournament_id = ?
               AND v.is_bust = 0
             GROUP BY m.id, m.round_label, m.bracket_label, p.id, p.display_name
             HAVING COUNT(v.id) > 0
             ORDER BY three_dart_average DESC, visits_logged DESC, p.display_name ASC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listStandingsByTournamentId(int $tournamentId, int $limit = 8): array
    {
        $sql = sprintf(
            'SELECT
                p.id,
                p.display_name,
                (
                    SELECT COUNT(*)
                    FROM `%1$smatches` mw
                    WHERE mw.tournament_id = tp.tournament_id
                      AND mw.status = "completed"
                      AND mw.winner_player_id = p.id
                ) AS wins,
                (
                    SELECT COUNT(*)
                    FROM `%1$smatches` ml
                    WHERE ml.tournament_id = tp.tournament_id
                      AND ml.status = "completed"
                      AND (ml.player_a_id = p.id OR ml.player_b_id = p.id)
                      AND ml.winner_player_id IS NOT NULL
                      AND ml.winner_player_id <> p.id
                ) AS losses,
                (
                    SELECT COUNT(*)
                    FROM `%1$slegs` lw
                    INNER JOIN `%1$smatches` mw2 ON mw2.id = lw.match_id
                    WHERE mw2.tournament_id = tp.tournament_id
                      AND lw.winner_player_id = p.id
                ) AS legs_won,
                (
                    SELECT COUNT(*)
                    FROM `%1$slegs` ll
                    INNER JOIN `%1$smatches` ml2 ON ml2.id = ll.match_id
                    WHERE ml2.tournament_id = tp.tournament_id
                      AND (ml2.player_a_id = p.id OR ml2.player_b_id = p.id)
                      AND ll.winner_player_id IS NOT NULL
                      AND ll.winner_player_id <> p.id
                ) AS legs_lost
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id = tp.player_id
             WHERE tp.tournament_id = ?
               AND tp.status <> "withdrawn"
             ORDER BY wins DESC, (legs_won - legs_lost) DESC, p.display_name ASC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        foreach ($rows as &$row) {
            $wins = (int) ($row['wins'] ?? 0);
            $losses = (int) ($row['losses'] ?? 0);
            $legsWon = (int) ($row['legs_won'] ?? 0);
            $legsLost = (int) ($row['legs_lost'] ?? 0);

            $row['match_points'] = $wins * 2;
            $row['leg_diff'] = $legsWon - $legsLost;
            $row['record'] = sprintf('%d-%d', $wins, $losses);
        }
        unset($row);

        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    public function getBoardAssignmentOverview(int $tournamentId): array
    {
        $tournament = $this->findById($tournamentId);

        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $boards = $this->listBoardAvailabilityForTournament($tournamentId, $clubId);
        $queue = $this->listAssignmentQueueForTournament($tournamentId, $clubId);

        return [
            'tournament' => $tournament,
            'boards' => $boards,
            'queue' => [
                'pending_count' => count(array_filter($queue, static fn (array $match): bool => (string) ($match['status'] ?? '') === 'pending')),
                'assigned_count' => count(array_filter($queue, static fn (array $match): bool => (string) ($match['status'] ?? '') === 'assigned')),
                'in_progress_count' => count(array_filter($queue, static fn (array $match): bool => (string) ($match['status'] ?? '') === 'in_progress')),
                'items' => $queue,
            ],
        ];
    }

    /**
     * @param array<int, mixed> $kioskIds
     * @return array<string, mixed>
     */
    public function replaceBoardAssignments(int $tournamentId, array $kioskIds): array
    {
        $tournament = $this->findById($tournamentId);

        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $normalizedIds = array_values(array_unique(array_filter(array_map(
            static fn (mixed $value): int => (int) $value,
            $kioskIds
        ), static fn (int $value): bool => $value > 0)));

        if ($normalizedIds !== []) {
            $allowedIds = $this->listClubKioskIds($clubId);

            foreach ($normalizedIds as $kioskId) {
                if (!in_array($kioskId, $allowedIds, true)) {
                    throw new ValidationException(
                        'kiosk_not_in_club',
                        'One or more selected boards do not belong to this club.'
                    );
                }
            }
        }

        $deleteSql = sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id = ?', $this->tablePrefix);
        $delete = $this->connection->prepare($deleteSql);
        $delete->bind_param('i', $tournamentId);
        $delete->execute();
        $delete->close();

        if ($normalizedIds !== []) {
            $insertSql = sprintf(
                'INSERT INTO `%1$stournament_kiosks` (tournament_id, kiosk_id, sort_order)
                 VALUES (?, ?, ?)',
                $this->tablePrefix
            );
            $insert = $this->connection->prepare($insertSql);
            $sortOrder = 1;

            foreach ($normalizedIds as $kioskId) {
                $insert->bind_param('iii', $tournamentId, $kioskId, $sortOrder);
                $insert->execute();
                $sortOrder++;
            }

            $insert->close();
        }

        return $this->getBoardAssignmentOverview($tournamentId);
    }

    /**
     * @return array<string, mixed>
     */
    public function autoAssignPendingMatches(int $tournamentId): array
    {
        $tournament = $this->findById($tournamentId);

        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $boards = $this->listBoardAvailabilityForTournament($tournamentId, $clubId);
        $availableBoards = array_values(array_filter(
            $boards,
            static fn (array $board): bool => (int) ($board['is_assigned_to_tournament'] ?? 0) === 1
                && (int) ($board['is_active'] ?? 0) === 1
                && (int) ($board['is_available'] ?? 0) === 1
        ));

        if ($availableBoards === []) {
            throw new ValidationException(
                'no_tournament_boards_available',
                'No available boards are assigned to this tournament.'
            );
        }

        $busyPlayers = $this->listBusyPlayerIdsByClub($clubId);
        $pendingMatches = array_values(array_filter(
            $this->listAssignmentQueueForTournament($tournamentId, $clubId),
            static fn (array $match): bool => (string) ($match['status'] ?? '') === 'pending'
        ));

        $assigned = [];
        $skipped = [];

        foreach ($pendingMatches as $match) {
            $playerAId = (int) ($match['player_a_id'] ?? 0);
            $playerBId = (int) ($match['player_b_id'] ?? 0);

            if (in_array($playerAId, $busyPlayers, true) || in_array($playerBId, $busyPlayers, true)) {
                $match['skip_reason'] = 'En eller begge spillere er opptatt i en annen aktiv kamp.';
                $skipped[] = $match;
                continue;
            }

            $board = array_shift($availableBoards);

            if ($board === null) {
                $match['skip_reason'] = 'Ingen ledige boards igjen i denne turneringen.';
                $skipped[] = $match;
                continue;
            }

            $kioskId = (int) ($board['id'] ?? 0);
            $status = 'assigned';
            $sql = sprintf(
                'UPDATE `%1$smatches`
                 SET kiosk_id = ?, status = ?, starts_at = NULL, finished_at = NULL
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $matchId = (int) $match['id'];
            $statement->bind_param('isi', $kioskId, $status, $matchId);
            $statement->execute();
            $statement->close();

            $busyPlayers[] = $playerAId;
            $busyPlayers[] = $playerBId;

            $assigned[] = [
                'match_id' => $matchId,
                'players' => trim((string) $match['player_a_name']) . ' vs ' . trim((string) $match['player_b_name']),
                'kiosk_id' => $kioskId,
                'kiosk_name' => $board['name'] ?? null,
                'board_number' => $board['board_number'] ?? null,
                'kiosk_code' => $board['code'] ?? null,
            ];
        }

        return [
            'tournament' => $tournament,
            'assigned_count' => count($assigned),
            'skipped_count' => count($skipped),
            'assigned' => $assigned,
            'skipped' => $skipped,
            'overview' => $this->getBoardAssignmentOverview($tournamentId),
        ];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function createMatch(int $tournamentId, array $payload): array
    {
        $playerAId = (int) ($payload['player_a_id'] ?? 0);
        $playerBId = (int) ($payload['player_b_id'] ?? 0);
        $kioskId = isset($payload['kiosk_id']) && (int) $payload['kiosk_id'] > 0 ? (int) $payload['kiosk_id'] : null;
        $roundLabel = $this->nullableString($payload['round_label'] ?? null);
        $bracketLabel = $this->nullableString($payload['bracket_label'] ?? null);
        $status = $kioskId !== null ? 'assigned' : 'pending';
        $bestOfLegs = max(1, (int) ($payload['best_of_legs'] ?? 3));
        $legsToWin = max(1, (int) ($payload['legs_to_win'] ?? intdiv($bestOfLegs, 2) + 1));
        $tournament = $this->findById($tournamentId);

        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $this->assertPlayersAreRegisteredForTournament($tournamentId, [$playerAId, $playerBId]);

        if ($kioskId !== null) {
            $this->assertKioskCanBeUsedForTournament($tournamentId, $clubId, $kioskId, null, $playerAId, $playerBId);
        }

        $sql = sprintf(
            'INSERT INTO `%1$smatches`
             (tournament_id, kiosk_id, round_label, bracket_label, status, best_of_legs, legs_to_win, player_a_id, player_b_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iisssiiii', $tournamentId, $kioskId, $roundLabel, $bracketLabel, $status, $bestOfLegs, $legsToWin, $playerAId, $playerBId);
        $statement->execute();
        $matchId = (int) $statement->insert_id;
        $statement->close();

        return $this->findMatchById($matchId) ?? [];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function assignMatchToKiosk(int $matchId, int $kioskId): ?array
    {
        $match = $this->findMatchById($matchId);

        if ($match === null) {
            return null;
        }

        $tournament = $this->findById((int) $match['tournament_id']);

        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }

        $clubId = (int) $tournament['club_id'];
        $this->assertKioskCanBeUsedForTournament(
            (int) $match['tournament_id'],
            $clubId,
            $kioskId,
            $matchId,
            (int) $match['player_a_id'],
            (int) $match['player_b_id']
        );

        $status = 'assigned';
        $sql = sprintf(
            'UPDATE `%1$smatches`
             SET kiosk_id = ?, status = ?, starts_at = NULL, finished_at = NULL
             WHERE id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('isi', $kioskId, $status, $matchId);
        $statement->execute();
        $statement->close();

        return $this->findMatchById($matchId);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getMemberDashboard(int $userId): ?array
    {
        $sql = sprintf(
            'SELECT
                ua.id,
                ua.username,
                ua.display_name,
                ua.role,
                mp.player_id,
                p.display_name AS player_display_name,
                p.club_id
             FROM `%1$suser_accounts` ua
             LEFT JOIN `%1$smember_profiles` mp ON mp.user_account_id = ua.id
             LEFT JOIN `%1$splayers` p ON p.id = mp.player_id
             WHERE ua.id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $userId);
        $statement->execute();
        $result = $statement->get_result();
        $user = $result->fetch_assoc() ?: null;
        $statement->close();

        if ($user === null) {
            return null;
        }

        $playerId = isset($user['player_id']) && $user['player_id'] !== null ? (int) $user['player_id'] : null;

        return [
            'user' => $user,
            'registrations' => $playerId !== null ? $this->listPlayerRegistrations($playerId) : [],
            'stats' => $playerId !== null ? $this->getPlayerStats($playerId) : [],
        ];
    }

    private function findActiveSeasonId(int $clubId): ?int
    {
        $sql = sprintf(
            'SELECT id FROM `%1$sseasons`
             WHERE club_id = ?
             ORDER BY is_active DESC, id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row !== null ? (int) $row['id'] : null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findMatchById(int $matchId): ?array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.tournament_id,
                m.kiosk_id,
                m.round_label,
                m.bracket_label,
                m.status,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                m.winner_player_id,
                m.starts_at,
                m.finished_at,
                k.code AS kiosk_code,
                k.name AS kiosk_name,
                k.board_number
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE m.id = ?
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<int, int>
     */
    private function listClubKioskIds(int $clubId): array
    {
        $sql = sprintf('SELECT id FROM `%1$skiosks` WHERE club_id = ?', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array{id:mixed}> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_map(static fn (array $row): int => (int) $row['id'], $rows);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listBoardAvailabilityForTournament(int $tournamentId, int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                k.id,
                k.code,
                k.name,
                k.board_number,
                k.sponsor_label,
                k.scoring_mode,
                k.is_active,
                CASE WHEN tk.id IS NULL THEN 0 ELSE 1 END AS is_assigned_to_tournament,
                (
                    SELECT m2.id
                    FROM `%1$smatches` m2
                    INNER JOIN `%1$stournaments` t2 ON t2.id = m2.tournament_id
                    WHERE m2.kiosk_id = k.id
                      AND m2.status IN ("assigned", "in_progress")
                      AND t2.club_id = ?
                    ORDER BY FIELD(m2.status, "in_progress", "assigned"), m2.id ASC
                    LIMIT 1
                ) AS busy_match_id,
                (
                    SELECT m3.status
                    FROM `%1$smatches` m3
                    INNER JOIN `%1$stournaments` t3 ON t3.id = m3.tournament_id
                    WHERE m3.kiosk_id = k.id
                      AND m3.status IN ("assigned", "in_progress")
                      AND t3.club_id = ?
                    ORDER BY FIELD(m3.status, "in_progress", "assigned"), m3.id ASC
                    LIMIT 1
                ) AS busy_match_status
             FROM `%1$skiosks` k
             LEFT JOIN `%1$stournament_kiosks` tk ON tk.kiosk_id = k.id AND tk.tournament_id = ?
             WHERE k.club_id = ?
             ORDER BY k.board_number ASC, k.id ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iiii', $clubId, $clubId, $tournamentId, $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        foreach ($rows as &$row) {
            $row['is_available'] = ($row['busy_match_id'] ?? null) === null ? 1 : 0;
        }
        unset($row);

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listAssignmentQueueForTournament(int $tournamentId, int $clubId): array
    {
        $rows = $this->listMatches($tournamentId);
        $busyPlayers = $this->listBusyPlayerIdsByClub($clubId);

        foreach ($rows as &$row) {
            $playerAId = (int) ($row['player_a_id'] ?? 0);
            $playerBId = (int) ($row['player_b_id'] ?? 0);
            $row['players_available'] = !in_array($playerAId, $busyPlayers, true) && !in_array($playerBId, $busyPlayers, true);
        }
        unset($row);

        return $rows;
    }

    /**
     * @return array<int, int>
     */
    private function listBusyPlayerIdsByClub(int $clubId): array
    {
        $sql = sprintf(
            'SELECT DISTINCT player_id
             FROM (
                SELECT m.player_a_id AS player_id
                FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
                WHERE t.club_id = ?
                  AND m.status IN ("assigned", "in_progress")
                UNION ALL
                SELECT m.player_b_id AS player_id
                FROM `%1$smatches` m
                INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
                WHERE t.club_id = ?
                  AND m.status IN ("assigned", "in_progress")
             ) busy',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $clubId, $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array{player_id:mixed}> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_values(array_unique(array_map(
            static fn (array $row): int => (int) $row['player_id'],
            $rows
        )));
    }

    /**
     * @param array<int, int> $playerIds
     */
    private function assertPlayersAreRegisteredForTournament(int $tournamentId, array $playerIds): void
    {
        $normalized = array_values(array_unique(array_filter($playerIds, static fn (int $value): bool => $value > 0)));

        if (count($normalized) !== 2) {
            throw new ValidationException('invalid_match_players', 'Two valid players are required to create a match.');
        }

        $sql = sprintf(
            'SELECT COUNT(*) AS total
             FROM `%1$stournament_players`
             WHERE tournament_id = ?
               AND status <> "withdrawn"
               AND player_id IN (?, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iii', $tournamentId, $normalized[0], $normalized[1]);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: ['total' => 0];
        $statement->close();

        if ((int) ($row['total'] ?? 0) !== count($normalized)) {
            throw new ValidationException(
                'players_not_registered_for_tournament',
                'Both players must be registered in the selected tournament before you can create a match.'
            );
        }
    }

    private function assertKioskCanBeUsedForTournament(
        int $tournamentId,
        int $clubId,
        int $kioskId,
        ?int $excludeMatchId,
        int $playerAId,
        int $playerBId
    ): void {
        $allowed = $this->listClubKioskIds($clubId);

        if (!in_array($kioskId, $allowed, true)) {
            throw new ValidationException('kiosk_not_in_club', 'The selected board does not belong to this club.');
        }

        $assignmentSql = sprintf(
            'SELECT id
             FROM `%1$stournament_kiosks`
             WHERE tournament_id = ? AND kiosk_id = ?
             LIMIT 1',
            $this->tablePrefix
        );
        $assignment = $this->connection->prepare($assignmentSql);
        $assignment->bind_param('ii', $tournamentId, $kioskId);
        $assignment->execute();
        $assignmentResult = $assignment->get_result();
        $assignedRow = $assignmentResult->fetch_assoc() ?: null;
        $assignment->close();

        if ($assignedRow === null) {
            throw new ValidationException(
                'kiosk_not_assigned_to_tournament',
                'The selected board is not assigned to this tournament.'
            );
        }

        $busySql = sprintf(
            'SELECT m.id
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             WHERE m.kiosk_id = ?
               AND m.status IN ("assigned", "in_progress")
               AND t.club_id = ?
               AND (? IS NULL OR m.id <> ?)
             LIMIT 1',
            $this->tablePrefix
        );
        $busy = $this->connection->prepare($busySql);
        $busy->bind_param('iiii', $kioskId, $clubId, $excludeMatchId, $excludeMatchId);
        $busy->execute();
        $busyResult = $busy->get_result();
        $busyRow = $busyResult->fetch_assoc() ?: null;
        $busy->close();

        if ($busyRow !== null) {
            throw new ValidationException(
                'kiosk_busy',
                'The selected board is already running or holding another active match.'
            );
        }

        $playersBusySql = sprintf(
            'SELECT id
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             WHERE t.club_id = ?
               AND m.status IN ("assigned", "in_progress")
               AND (? IS NULL OR m.id <> ?)
               AND (
                    m.player_a_id IN (?, ?)
                    OR m.player_b_id IN (?, ?)
               )
             LIMIT 1',
            $this->tablePrefix
        );
        $playersBusy = $this->connection->prepare($playersBusySql);
        $playersBusy->bind_param('iiiiiii', $clubId, $excludeMatchId, $excludeMatchId, $playerAId, $playerBId, $playerAId, $playerBId);
        $playersBusy->execute();
        $playersBusyResult = $playersBusy->get_result();
        $playersBusyRow = $playersBusyResult->fetch_assoc() ?: null;
        $playersBusy->close();

        if ($playersBusyRow !== null) {
            throw new ValidationException(
                'players_not_available',
                'One or both players are already in another assigned or active match.'
            );
        }
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listPlayerRegistrations(int $playerId): array
    {
        $sql = sprintf(
            'SELECT
                tp.tournament_id,
                tp.status,
                tp.seed,
                tp.created_at,
                t.name AS tournament_name,
                t.status AS tournament_status,
                c.id AS club_id,
                c.name AS club_name
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$stournaments` t ON t.id = tp.tournament_id
             INNER JOIN `%1$sclubs` c ON c.id = t.club_id
             WHERE tp.player_id = ?
             ORDER BY tp.created_at DESC',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $playerId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    private function getPlayerStats(int $playerId): array
    {
        $matchSql = sprintf(
            'SELECT
                COUNT(*) AS matches_played,
                COUNT(CASE WHEN winner_player_id = ? THEN 1 END) AS matches_won
             FROM `%1$smatches`
             WHERE player_a_id = ? OR player_b_id = ?',
            $this->tablePrefix
        );
        $matchStatement = $this->connection->prepare($matchSql);
        $matchStatement->bind_param('iii', $playerId, $playerId, $playerId);
        $matchStatement->execute();
        $matchResult = $matchStatement->get_result();
        $stats = $matchResult->fetch_assoc() ?: [];
        $matchStatement->close();

        $legSql = sprintf(
            'SELECT COUNT(*) AS legs_won
             FROM `%1$slegs`
             WHERE winner_player_id = ?',
            $this->tablePrefix
        );
        $legStatement = $this->connection->prepare($legSql);
        $legStatement->bind_param('i', $playerId);
        $legStatement->execute();
        $legResult = $legStatement->get_result();
        $legStats = $legResult->fetch_assoc() ?: ['legs_won' => 0];
        $legStatement->close();

        $visitSql = sprintf(
            'SELECT COUNT(*) AS visits_logged, COALESCE(AVG(score), 0) AS average_visit_score
             FROM `%1$svisits`
             WHERE player_id = ?',
            $this->tablePrefix
        );
        $visitStatement = $this->connection->prepare($visitSql);
        $visitStatement->bind_param('i', $playerId);
        $visitStatement->execute();
        $visitResult = $visitStatement->get_result();
        $visitStats = $visitResult->fetch_assoc() ?: ['visits_logged' => 0, 'average_visit_score' => 0];
        $visitStatement->close();

        $stats['legs_won'] = $legStats['legs_won'] ?? 0;
        $stats['visits_logged'] = $visitStats['visits_logged'] ?? 0;
        $stats['average_visit_score'] = $visitStats['average_visit_score'] ?? 0;

        $rankingSql = sprintf(
            'SELECT ranking_type, scope_type, points, position, calculated_at
             FROM `%1$sranking_snapshots`
             WHERE player_id = ?
             ORDER BY calculated_at DESC, id DESC
             LIMIT 8',
            $this->tablePrefix
        );
        $ranking = $this->connection->prepare($rankingSql);
        $ranking->bind_param('i', $playerId);
        $ranking->execute();
        $rankingResult = $ranking->get_result();
        /** @var array<int, array<string, mixed>> $rankingRows */
        $rankingRows = $rankingResult->fetch_all(MYSQLI_ASSOC);
        $ranking->close();

        $stats['rankings'] = $rankingRows;

        return $stats;
    }

    private function slugify(string $value): string
    {
        $value = trim($value);
        $value = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value) ?: $value;
        $value = strtolower($value);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? 'tournament';
        $value = trim($value, '-');

        return $value !== '' ? substr($value, 0, 180) : 'tournament';
    }

    private function nullableString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $trimmed = trim($value);
        return $trimmed !== '' ? $trimmed : null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listTopVisits(int $tournamentId, int $limit, bool $todayOnly): array
    {
        $todaySql = $todayOnly ? ' AND DATE(v.created_at) = CURDATE()' : '';

        $sql = sprintf(
            'SELECT
                v.id,
                v.score,
                v.created_at,
                p.display_name,
                k.board_number,
                k.sponsor_label
             FROM `%1$svisits` v
             INNER JOIN `%1$smatches` m ON m.id = v.match_id
             INNER JOIN `%1$splayers` p ON p.id = v.player_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE m.tournament_id = ?
               AND v.is_bust = 0
               AND v.score > 0%3$s
             ORDER BY v.score DESC, v.created_at DESC
             LIMIT %2$d',
            $this->tablePrefix,
            $limit,
            $todaySql
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }
}
