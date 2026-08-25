<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class EloReconciliationService
{
    private mysqli $connection;
    private string $tablePrefix;
    private EloLedgerService $ledger;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->ledger = new EloLedgerService($database);
    }

    public function reconcileKiosk(int $kioskId): void
    {
        foreach ($this->completedMatchesNeedingLedger($kioskId) as $matchId) {
            $this->ledger->applyCompletedMatch($matchId);
        }
        foreach ($this->appliedEventsForReopenedMatches($kioskId) as $matchId) {
            $this->ledger->revertMatch($matchId);
        }
    }

    /** @return array<int,int> */
    private function completedMatchesNeedingLedger(int $kioskId): array
    {
        $sql = sprintf(
            'SELECT m.id
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             LEFT JOIN `%1$selo_match_events` e ON e.match_id=m.id AND e.status="applied"
             WHERE m.kiosk_id=? AND m.status="completed" AND t.elo_enabled=1 AND t.season_id IS NOT NULL
               AND (e.id IS NULL OR NOT (e.winner_player_id <=> m.winner_player_id))
             ORDER BY COALESCE(m.finished_at, m.updated_at) ASC, m.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['id'], $rows);
    }

    /** @return array<int,int> */
    private function appliedEventsForReopenedMatches(int $kioskId): array
    {
        $sql = sprintf(
            'SELECT e.match_id
             FROM `%1$selo_match_events` e
             INNER JOIN `%1$smatches` m ON m.id=e.match_id
             WHERE m.kiosk_id=? AND e.status="applied" AND m.status<>"completed"
             ORDER BY e.applied_at ASC, e.id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['match_id'], $rows);
    }
}
