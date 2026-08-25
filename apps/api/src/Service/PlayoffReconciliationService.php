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
            $this->restoreReopenedMatchParticipants($matchId);
        }
        $this->playoffs->reconcileByMatchId($matchId);
    }

    private function restoreReopenedMatchParticipants(int $matchId): void
    {
        $sql = sprintf(
            'SELECT m.tournament_id, m.player_a_id, m.player_b_id,
                    EXISTS(
                        SELECT 1 FROM `%1$stournament_playoff_nodes` n WHERE n.match_id=m.id
                    ) AS is_playoff
             FROM `%1$smatches` m WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($match === null || (int) ($match['is_playoff'] ?? 0) !== 1) {
            return;
        }

        $tournamentId = (int) $match['tournament_id'];
        foreach ([(int) $match['player_a_id'], (int) $match['player_b_id']] as $playerId) {
            $breakSql = sprintf(
                'SELECT 1 FROM `%1$stournament_player_breaks`
                 WHERE tournament_id=? AND player_id=? AND status IN ("scheduled","active")
                 ORDER BY id DESC LIMIT 1',
                $this->tablePrefix
            );
            $breakStmt = $this->connection->prepare($breakSql);
            $breakStmt->bind_param('ii', $tournamentId, $playerId);
            $breakStmt->execute();
            $hasBreak = $breakStmt->get_result()->fetch_assoc() !== null;
            $breakStmt->close();

            $status = $hasBreak ? 'paused' : 'checked_in';
            $update = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players` SET status=? WHERE tournament_id=? AND player_id=?',
                $this->tablePrefix
            ));
            $update->bind_param('sii', $status, $tournamentId, $playerId);
            $update->execute();
            $update->close();
        }
    }
}
