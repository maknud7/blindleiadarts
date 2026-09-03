<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\EloLedgerRepository;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class EloLedgerService
{
    private mysqli $connection;
    private EloLedgerRepository $ledger;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->ledger = new EloLedgerRepository($database);
        $this->tablePrefix = $database->tablePrefix();
    }

    public function applyCompletedMatch(int $matchId): void
    {
        $this->transaction(fn () => $this->ledger->applyCompletedMatch($matchId));
    }

    public function revertMatch(int $matchId): void
    {
        $this->transaction(fn () => $this->ledger->revertMatch($matchId));
    }

    /** @return array{reverted_events:int,rebuilt_seasons:int} */
    public function reconcileGuestMatches(): array
    {
        $this->connection->begin_transaction();
        try {
            // mysqli::affected_rows is not a reliable aggregate after prepared statements
            // have been closed. Measure the actual ledger-state delta around reconciliation.
            $before = $this->revertedEventCount();
            $result = $this->ledger->reconcileGuestMatches();
            $after = $this->revertedEventCount();
            $result['reverted_events'] = max(
                (int) ($result['reverted_events'] ?? 0),
                max(0, $after - $before)
            );
            $this->connection->commit();
            return $result;
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    private function revertedEventCount(): int
    {
        $sql = sprintf(
            'SELECT COUNT(*) AS c FROM `%1$selo_match_events` WHERE status="reverted"',
            $this->tablePrefix
        );
        $row = $this->connection->query($sql)->fetch_assoc() ?: [];
        return (int) ($row['c'] ?? 0);
    }

    /** @param callable():void $callback */
    private function transaction(callable $callback): void
    {
        $this->connection->begin_transaction();
        try {
            $callback();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }
}
