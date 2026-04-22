<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class KioskRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findKioskStateByCode(string $kioskCode): ?array
    {
        $kiosk = $this->findKioskByCode($kioskCode);

        if ($kiosk === null) {
            return null;
        }

        $match = $this->findActiveMatchForKiosk((int) $kiosk['id']);

        if ($match === null) {
            return [
                'kiosk' => [
                    'id' => (int) $kiosk['id'],
                    'code' => $kiosk['code'],
                    'name' => $kiosk['name'],
                    'board_number' => (int) $kiosk['board_number'],
                    'sponsor_label' => $kiosk['sponsor_label'],
                    'sponsor_logo_url' => $kiosk['sponsor_logo_url'],
                ],
                'state' => 'idle',
                'message' => 'No assigned or active match for this kiosk.',
            ];
        }

        return [
            'kiosk' => [
                'id' => (int) $kiosk['id'],
                'code' => $kiosk['code'],
                'name' => $kiosk['name'],
                'board_number' => (int) $kiosk['board_number'],
                'sponsor_label' => $kiosk['sponsor_label'],
                'sponsor_logo_url' => $kiosk['sponsor_logo_url'],
            ],
            'state' => $match['status'],
            'match' => [
                'id' => (int) $match['id'],
                'status' => $match['status'],
                'round_label' => $match['round_label'],
                'bracket_label' => $match['bracket_label'],
                'best_of_legs' => (int) $match['best_of_legs'],
                'legs_to_win' => (int) $match['legs_to_win'],
                'player_a' => [
                    'id' => (int) $match['player_a_id'],
                    'display_name' => $match['player_a_name'],
                ],
                'player_b' => [
                    'id' => (int) $match['player_b_id'],
                    'display_name' => $match['player_b_name'],
                ],
                'winner_player_id' => $match['winner_player_id'] !== null ? (int) $match['winner_player_id'] : null,
                'starts_at' => $match['starts_at'],
                'finished_at' => $match['finished_at'],
            ],
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findKioskByCode(string $kioskCode): ?array
    {
        $sql = sprintf(
            'SELECT id, code, name, board_number, sponsor_label, sponsor_logo_url
             FROM `%1$skiosks`
             WHERE code = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $kioskCode);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findActiveMatchForKiosk(int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.status,
                m.round_label,
                m.bracket_label,
                m.best_of_legs,
                m.legs_to_win,
                m.player_a_id,
                m.player_b_id,
                m.winner_player_id,
                m.starts_at,
                m.finished_at,
                pa.display_name AS player_a_name,
                pb.display_name AS player_b_name
             FROM `%1$smatches` m
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             WHERE m.kiosk_id = ?
               AND m.status IN ("assigned", "in_progress")
             ORDER BY FIELD(m.status, "in_progress", "assigned"), m.id ASC
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $kioskId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }
}
