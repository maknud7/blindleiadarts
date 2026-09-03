<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Replays the canonical completed-match ledger through the same runtime ELO boundary.
 * This is intentionally maintenance-oriented: it restores missing/reverted eligible
 * member matches and leaves true guest matches ELO-neutral.
 */
final class EloCanonicalReplayService
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

    /**
     * @return array{completed_matches:int,guest_events_reverted:int,seasons_rebuilt:int}
     */
    public function replay(): array
    {
        $sql = sprintf(
            'SELECT m.id
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             WHERE m.status="completed" AND t.elo_enabled=1 AND t.season_id IS NOT NULL
             ORDER BY COALESCE(t.start_at,m.created_at) ASC, t.id ASC,
                      COALESCE(m.finished_at,m.starts_at,m.created_at) ASC, m.id ASC',
            $this->tablePrefix
        );
        $rows = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);

        foreach ($rows as $row) {
            $matchId = (int) ($row['id'] ?? 0);
            if ($matchId > 0) {
                $this->ledger->applyCompletedMatch($matchId);
            }
        }

        $guest = $this->ledger->reconcileGuestMatches();

        return [
            'completed_matches' => count($rows),
            'guest_events_reverted' => (int) ($guest['reverted_events'] ?? 0),
            'seasons_rebuilt' => (int) ($guest['rebuilt_seasons'] ?? 0),
        ];
    }
}
