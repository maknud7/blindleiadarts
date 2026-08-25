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

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->ledger = new EloLedgerRepository($database);
    }

    public function applyCompletedMatch(int $matchId): void
    {
        $this->transaction(fn () => $this->ledger->applyCompletedMatch($matchId));
    }

    public function revertMatch(int $matchId): void
    {
        $this->transaction(fn () => $this->ledger->revertMatch($matchId));
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
