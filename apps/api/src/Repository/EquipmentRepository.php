<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class EquipmentRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    public function deleteBoard(int $clubId, int $kioskId): bool
    {
        if (!$this->boardExists($clubId, $kioskId)) {
            return false;
        }

        $matchCount = $this->countBoardMatches($kioskId);
        if ($matchCount > 0) {
            throw new ValidationException(
                'board_has_match_history',
                sprintf('Skiva er brukt i %d kamp%s og kan ikke slettes. Deaktiver den i stedet.', $matchCount, $matchCount === 1 ? '' : 'er'),
                409
            );
        }

        $this->connection->begin_transaction();
        try {
            $this->deleteWhere('tournament_board_reservations', 'kiosk_id', $kioskId);
            $this->deleteWhere('tournament_kiosks', 'kiosk_id', $kioskId);
            $this->deleteWhere('kiosk_sessions', 'kiosk_id', $kioskId);

            $pairingSql = sprintf(
                'UPDATE `%1$skiosk_pairing_requests` SET approved_kiosk_id=NULL WHERE approved_kiosk_id=?',
                $this->tablePrefix
            );
            $pairing = $this->connection->prepare($pairingSql);
            $pairing->bind_param('i', $kioskId);
            $pairing->execute();
            $pairing->close();

            $sql = sprintf('DELETE FROM `%1$skiosks` WHERE id=? AND club_id=?', $this->tablePrefix);
            $statement = $this->connection->prepare($sql);
            $statement->bind_param('ii', $kioskId, $clubId);
            $statement->execute();
            $deleted = $statement->affected_rows > 0;
            $statement->close();

            $this->connection->commit();
            return $deleted;
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    public function deleteScreen(int $clubId, int $screenId): bool
    {
        $sql = sprintf('DELETE FROM `%1$sscreen_devices` WHERE id=? AND club_id=?', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $screenId, $clubId);
        $statement->execute();
        $deleted = $statement->affected_rows > 0;
        $statement->close();
        return $deleted;
    }

    private function boardExists(int $clubId, int $kioskId): bool
    {
        $sql = sprintf('SELECT 1 FROM `%1$skiosks` WHERE id=? AND club_id=? LIMIT 1', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $kioskId, $clubId);
        $statement->execute();
        $exists = $statement->get_result()->fetch_assoc() !== null;
        $statement->close();
        return $exists;
    }

    private function countBoardMatches(int $kioskId): int
    {
        $sql = sprintf('SELECT COUNT(*) AS c FROM `%1$smatches` WHERE kiosk_id=?', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $kioskId);
        $statement->execute();
        $count = (int) ($statement->get_result()->fetch_assoc()['c'] ?? 0);
        $statement->close();
        return $count;
    }

    private function deleteWhere(string $table, string $column, int $id): void
    {
        $sql = sprintf('DELETE FROM `%1$s%2$s` WHERE `%3$s`=?', $this->tablePrefix, $table, $column);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $id);
        $statement->execute();
        $statement->close();
    }
}
