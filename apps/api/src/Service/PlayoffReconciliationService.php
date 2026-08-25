<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\TournamentPlayoffRepository;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class PlayoffReconciliationService
{
    private mysqli $connection;
    private string $tablePrefix;
    private TournamentPlayoffRepository $playoffs;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->playoffs = new TournamentPlayoffRepository($database);
    }

    public function targetMatchIdForKiosk(int $kioskId, bool $includeCompleted): ?int
    {
        $statuses = $includeCompleted
            ? '("in_progress","assigned","completed")'
            : '("in_progress","assigned")';
        $sql = sprintf(
            'SELECT id FROM `%1$smatches`
             WHERE kiosk_id=? AND status IN %2$s
             ORDER BY FIELD(status,"in_progress","assigned","completed"),
                      CASE WHEN status="completed" THEN id END DESC,
                      CASE WHEN status<>"completed" THEN id END ASC
             LIMIT 1',
            $this->tablePrefix,
            $statuses
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row === null ? null : (int) $row['id'];
    }

    public function assertUndoAllowed(int $kioskId): ?int
    {
        $matchId = $this->targetMatchIdForKiosk($kioskId, true);
        if ($matchId !== null) {
            $this->playoffs->assertUndoAllowedForMatch($matchId);
        }
        return $matchId;
    }

    public function afterMutation(?int $matchId, bool $wasUndo): void
    {
        if ($matchId === null) {
            return;
        }
        if ($wasUndo) {
            $this->playoffs->rewindAfterUndo($matchId);
        }
        $this->playoffs->reconcileByMatchId($matchId);
    }
}
