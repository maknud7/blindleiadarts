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
}
