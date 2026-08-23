<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class DartsAtlasScreenRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<int, array<string, mixed>> */
    public function listScreenBoardsByTournament(int $clubId, int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT
                k.id AS kiosk_id,
                k.club_id,
                c.name AS club_name,
                c.logo_url AS club_logo_url,
                k.code AS kiosk_code,
                k.name AS kiosk_name,
                k.board_number,
                k.sponsor_label,
                k.sponsor_logo_url,
                k.scoring_mode,
                k.pairing_token_hash,
                k.paired_device_name,
                k.paired_at,
                m.id AS match_id,
                m.status AS match_status,
                m.round_label,
                m.bracket_label,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                m.winner_player_id,
                lms.player_a_score,
                lms.player_b_score,
                lms.player_a_legs,
                lms.player_b_legs,
                lms.throwing_player_id,
                lms.provider_status,
                lms.provider_updated_at,
                sa.average AS player_a_average,
                sa.first_nine_average AS player_a_first_nine,
                sa.highest_checkout AS player_a_highest_checkout,
                sa.score_180 AS player_a_180,
                sb.average AS player_b_average,
                sb.first_nine_average AS player_b_first_nine,
                sb.highest_checkout AS player_b_highest_checkout,
                sb.score_180 AS player_b_180
             FROM `%1$skiosks` k
             INNER JOIN `%1$sclubs` c ON c.id = k.club_id
             LEFT JOIN `%1$smatches` m ON m.id = (
                SELECT m2.id
                FROM `%1$smatches` m2
                WHERE m2.tournament_id = ?
                  AND m2.kiosk_id = k.id
                  AND m2.status IN ("in_progress", "assigned")
                ORDER BY FIELD(m2.status, "in_progress", "assigned"), m2.id ASC
                LIMIT 1
             )
             LEFT JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             LEFT JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$slive_match_states` lms ON lms.match_id = m.id
             LEFT JOIN `%1$smatch_statistics` sa ON sa.match_id = m.id AND sa.player_id = m.player_a_id
             LEFT JOIN `%1$smatch_statistics` sb ON sb.match_id = m.id AND sb.player_id = m.player_b_id
             WHERE k.club_id = ? AND k.is_active = 1
             ORDER BY k.board_number ASC, k.name ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $tournamentId, $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $boards = [];

        while ($row = $result->fetch_assoc()) {
            $kiosk = $this->formatKiosk($row);
            if ($row['match_id'] === null) {
                $boards[] = [
                    'kiosk' => $kiosk,
                    'state' => 'idle',
                    'match' => null,
                ];
                continue;
            }

            $status = (string) ($row['match_status'] ?? 'assigned');
            $scoreA = $row['player_a_score'] !== null ? (int) $row['player_a_score'] : null;
            $scoreB = $row['player_b_score'] !== null ? (int) $row['player_b_score'] : null;
            $legsA = $row['player_a_legs'] !== null ? (int) $row['player_a_legs'] : 0;
            $legsB = $row['player_b_legs'] !== null ? (int) $row['player_b_legs'] : 0;

            $boards[] = [
                'kiosk' => $kiosk,
                'state' => $status,
                'provider' => 'dartsatlas',
                'match' => [
                    'id' => (int) $row['match_id'],
                    'status' => $status,
                    'round_label' => $row['round_label'],
                    'bracket_label' => $row['bracket_label'],
                    'best_of_legs' => (int) $row['best_of_legs'],
                    'legs_to_win' => (int) $row['legs_to_win'],
                    'player_a' => [
                        'id' => (int) $row['player_a_id'],
                        'display_name' => (string) $row['player_a_name'],
                        'remaining' => $scoreA,
                        'legs_won' => $legsA,
                        'average' => $this->nullableFloat($row['player_a_average']),
                        'first_nine_average' => $this->nullableFloat($row['player_a_first_nine']),
                        'highest_checkout' => $this->nullableInt($row['player_a_highest_checkout']),
                        'score_180' => (int) ($row['player_a_180'] ?? 0),
                    ],
                    'player_b' => [
                        'id' => (int) $row['player_b_id'],
                        'display_name' => (string) $row['player_b_name'],
                        'remaining' => $scoreB,
                        'legs_won' => $legsB,
                        'average' => $this->nullableFloat($row['player_b_average']),
                        'first_nine_average' => $this->nullableFloat($row['player_b_first_nine']),
                        'highest_checkout' => $this->nullableInt($row['player_b_highest_checkout']),
                        'score_180' => (int) ($row['player_b_180'] ?? 0),
                    ],
                    'winner_player_id' => $row['winner_player_id'] !== null ? (int) $row['winner_player_id'] : null,
                    'current_player_id' => $row['throwing_player_id'] !== null ? (int) $row['throwing_player_id'] : null,
                    'provider_status' => $row['provider_status'],
                    'provider_updated_at' => $row['provider_updated_at'],
                    'recent_visits' => [],
                ],
            ];
        }

        $statement->close();
        return $boards;
    }

    /** @return array<int, array<string, mixed>> */
    public function listStandingsByTournamentId(int $tournamentId, int $limit = 8): array
    {
        $sql = sprintf(
            'SELECT
                p.id,
                p.display_name,
                SUM(CASE WHEN m.status = "completed" AND m.winner_player_id = p.id THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN m.status = "completed" AND m.winner_player_id IS NOT NULL AND m.winner_player_id <> p.id THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(ms.legs_won), 0) AS legs_won,
                COALESCE(SUM(
                    CASE
                        WHEN m.player_a_id = p.id THEN ms_opp_b.legs_won
                        WHEN m.player_b_id = p.id THEN ms_opp_a.legs_won
                        ELSE 0
                    END
                ), 0) AS legs_lost
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id = tp.player_id
             LEFT JOIN `%1$smatches` m
                ON m.tournament_id = tp.tournament_id
               AND (m.player_a_id = p.id OR m.player_b_id = p.id)
             LEFT JOIN `%1$smatch_statistics` ms ON ms.match_id = m.id AND ms.player_id = p.id
             LEFT JOIN `%1$smatch_statistics` ms_opp_a ON ms_opp_a.match_id = m.id AND ms_opp_a.player_id = m.player_a_id
             LEFT JOIN `%1$smatch_statistics` ms_opp_b ON ms_opp_b.match_id = m.id AND ms_opp_b.player_id = m.player_b_id
             WHERE tp.tournament_id = ? AND tp.status <> "withdrawn"
             GROUP BY p.id, p.display_name
             ORDER BY wins DESC, (legs_won - legs_lost) DESC, p.display_name ASC
             LIMIT %2$d',
            $this->tablePrefix,
            max(1, $limit)
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
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

    /** @return array<int, array<string, mixed>> */
    public function listBestMatchAveragesByTournamentId(int $tournamentId, int $limit = 5): array
    {
        $sql = sprintf(
            'SELECT
                m.id AS match_id,
                m.round_label,
                m.bracket_label,
                p.id AS player_id,
                p.display_name,
                ms.average AS three_dart_average,
                ms.darts_thrown,
                ms.first_nine_average,
                ms.highest_checkout,
                ms.score_180
             FROM `%1$smatch_statistics` ms
             INNER JOIN `%1$smatches` m ON m.id = ms.match_id
             INNER JOIN `%1$splayers` p ON p.id = ms.player_id
             WHERE m.tournament_id = ? AND ms.average IS NOT NULL
             ORDER BY ms.average DESC, ms.darts_thrown DESC, p.display_name ASC
             LIMIT %2$d',
            $this->tablePrefix,
            max(1, $limit)
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        foreach ($rows as &$row) {
            $row['visits_logged'] = isset($row['darts_thrown']) && $row['darts_thrown'] !== null
                ? (int) ceil(((int) $row['darts_thrown']) / 3)
                : 0;
            $row['three_dart_average'] = $row['three_dart_average'] !== null ? (float) $row['three_dart_average'] : null;
        }
        unset($row);

        return $rows;
    }

    /** @return array<string, mixed> */
    public function highlights(int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT
                COALESCE(SUM(COALESCE(ms.score_180, 0)), 0) AS total_180,
                MAX(ms.highest_checkout) AS highest_checkout,
                MAX(ms.average) AS best_average
             FROM `%1$smatch_statistics` ms
             INNER JOIN `%1$smatches` m ON m.id = ms.match_id
             WHERE m.tournament_id = ?',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $summary = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();

        $checkout = $this->topStatRow($tournamentId, 'highest_checkout');
        $average = $this->topStatRow($tournamentId, 'average');

        return [
            'total_180' => (int) ($summary['total_180'] ?? 0),
            'highest_checkout' => $checkout,
            'best_average' => $average,
        ];
    }

    /** @return array<string, mixed> */
    public function feedStatus(int $tournamentId): array
    {
        $resources = $this->tablePrefix . 'connector_resources';
        $references = $this->tablePrefix . 'external_references';
        $sql = "SELECT MAX(cr.last_seen_at) AS last_seen_at
                FROM `{$resources}` cr
                WHERE cr.external_system = 'dartsatlas'
                  AND (
                    cr.parent_external_id IN (
                        SELECT er.external_id FROM `{$references}` er
                        WHERE er.external_system = 'dartsatlas'
                          AND er.external_entity_type = 'tournament'
                          AND er.internal_entity_type = 'tournament'
                          AND er.internal_id = ?
                    )
                    OR (cr.resource_type = 'tournament' AND cr.external_id IN (
                        SELECT er2.external_id FROM `{$references}` er2
                        WHERE er2.external_system = 'dartsatlas'
                          AND er2.external_entity_type = 'tournament'
                          AND er2.internal_entity_type = 'tournament'
                          AND er2.internal_id = ?
                    ))
                  )";
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $tournamentId, $tournamentId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();
        $lastSeen = $row['last_seen_at'] ?? null;
        $age = $lastSeen !== null ? max(0, time() - strtotime((string) $lastSeen)) : null;

        return [
            'provider' => 'dartsatlas',
            'status' => $age === null ? 'idle' : ($age <= 30 ? 'live' : ($age <= 120 ? 'delayed' : 'stale')),
            'last_seen_at' => $lastSeen,
            'age_seconds' => $age,
        ];
    }

    /** @return array<string, mixed>|null */
    private function topStatRow(int $tournamentId, string $column): ?array
    {
        if (!in_array($column, ['highest_checkout', 'average'], true)) {
            return null;
        }

        $sql = sprintf(
            'SELECT ms.%3$s AS value, p.id AS player_id, p.display_name, m.id AS match_id
             FROM `%1$smatch_statistics` ms
             INNER JOIN `%1$smatches` m ON m.id = ms.match_id
             INNER JOIN `%1$splayers` p ON p.id = ms.player_id
             WHERE m.tournament_id = ? AND ms.%3$s IS NOT NULL
             ORDER BY ms.%3$s DESC, ms.id DESC
             LIMIT 1',
            $this->tablePrefix,
            $tournamentId,
            $column
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($row === null) {
            return null;
        }

        return [
            'value' => $column === 'average' ? (float) $row['value'] : (int) $row['value'],
            'player_id' => (int) $row['player_id'],
            'display_name' => (string) $row['display_name'],
            'match_id' => (int) $row['match_id'],
        ];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    private function formatKiosk(array $row): array
    {
        return [
            'id' => (int) $row['kiosk_id'],
            'code' => $row['kiosk_code'],
            'name' => $row['kiosk_name'],
            'club' => [
                'id' => (int) $row['club_id'],
                'name' => $row['club_name'],
                'logo_url' => $row['club_logo_url'],
            ],
            'board_number' => (int) $row['board_number'],
            'sponsor_label' => $row['sponsor_label'],
            'sponsor_logo_url' => $row['sponsor_logo_url'],
            'scoring_mode' => $row['scoring_mode'] ?? 'manual',
            'is_paired' => !empty($row['pairing_token_hash']),
            'paired_device_name' => $row['paired_device_name'] ?? null,
            'paired_at' => $row['paired_at'] ?? null,
        ];
    }

    private function nullableInt(mixed $value): ?int
    {
        return $value === null || $value === '' ? null : (int) $value;
    }

    private function nullableFloat(mixed $value): ?float
    {
        return $value === null || $value === '' ? null : (float) $value;
    }
}
