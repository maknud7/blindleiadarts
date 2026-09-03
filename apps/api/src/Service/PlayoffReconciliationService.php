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
        } else {
            $this->autoCreatePlannedPlayoff($matchId);
        }
        $this->playoffs->reconcileByMatchId($matchId);
    }

    private function autoCreatePlannedPlayoff(int $matchId): void
    {
        $sql = sprintf(
            'SELECT m.tournament_id, m.tournament_group_id, m.status,
                    t.planned_tournament_format, t.planned_auto_create_playoff,
                    t.planned_qualifiers_per_group, t.planned_playoff_best_of_legs
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             WHERE m.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($row === null
            || $row['tournament_group_id'] === null
            || (string) ($row['status'] ?? '') !== 'completed'
            || (string) ($row['planned_tournament_format'] ?? '') !== 'groups_playoff'
            || (int) ($row['planned_auto_create_playoff'] ?? 1) !== 1) {
            return;
        }

        $tournamentId = (int) $row['tournament_id'];
        if ($this->playoffs->findByTournamentId($tournamentId) !== null) {
            return;
        }

        $countsSql = sprintf(
            'SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status<>"completed" THEN 1 ELSE 0 END) AS open_count
             FROM `%1$smatches`
             WHERE tournament_id=? AND tournament_group_id IS NOT NULL',
            $this->tablePrefix
        );
        $counts = $this->connection->prepare($countsSql);
        $counts->bind_param('i', $tournamentId);
        $counts->execute();
        $matchCounts = $counts->get_result()->fetch_assoc() ?: [];
        $counts->close();
        if ((int) ($matchCounts['total'] ?? 0) < 1 || (int) ($matchCounts['open_count'] ?? 0) > 0) {
            return;
        }

        $qualifiers = max(1, (int) ($row['planned_qualifiers_per_group'] ?? 2));
        $bestOf = max(1, (int) ($row['planned_playoff_best_of_legs'] ?? 3));
        $this->playoffs->generateFromGroups($tournamentId, $qualifiers, $bestOf);
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
