<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Tournament-placement ranking: every entrant starts on one point and every
 * level reached in the knockout ladder adds one point. The field-size ceiling
 * is 1 + ceil(log2(entrants)), which gives 5 points to a 9-16 player event,
 * 6 points to a 17-32 player event, and so on.
 */
final class LinearRankingService
{
    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
    }

    public function reconcileByMatchId(?int $matchId): void
    {
        if ($matchId === null) {
            return;
        }
        $stmt = $this->connection->prepare(sprintf(
            'SELECT tournament_id FROM `%1$smatches` WHERE id=? LIMIT 1',
            $this->prefix
        ));
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            $this->reconcileTournament((int) $row['tournament_id']);
        }
    }

    public function reconcileTournament(int $tournamentId): void
    {
        $tournament = $this->tournament($tournamentId);
        if ($tournament === null || $tournament['season_id'] === null || (string) $tournament['ranking_method'] !== 'linear') {
            return;
        }
        $seasonId = (int) $tournament['season_id'];
        if ((string) $tournament['status'] !== 'completed') {
            $this->revertTournament($tournamentId);
            return;
        }

        $participants = $this->participants($tournamentId);
        $entrants = count($participants);
        if ($entrants === 0) {
            return;
        }

        $maximum = self::maximumPoints($entrants);
        $rows = [];
        foreach ($participants as $playerId) {
            $rows[$playerId] = [
                'points' => 1,
                'stage_label' => 'Deltaker',
                'stage_number' => 0,
                'metadata' => ['calculation' => 'field_size_and_stage'],
            ];
        }

        $playoff = $this->playoff($tournamentId);
        if ($playoff !== null) {
            $bracketSize = max(2, (int) $playoff['bracket_size']);
            $roundCount = max(1, (int) round(log($bracketSize, 2)));
            $firstPlayoffPoints = max(1, $maximum - $roundCount);
            $championId = $playoff['champion_player_id'] !== null ? (int) $playoff['champion_player_id'] : null;

            foreach ($this->playoffProgress((int) $playoff['id']) as $progress) {
                $playerId = (int) $progress['player_id'];
                if (!isset($rows[$playerId])) {
                    continue;
                }
                $round = max(1, (int) $progress['round_number']);
                $points = $championId === $playerId
                    ? $maximum
                    : min($maximum - 1, $firstPlayoffPoints + $round - 1);
                $rows[$playerId] = [
                    'points' => max(1, $points),
                    'stage_label' => (string) ($progress['round_label'] ?: 'Sluttspill'),
                    'stage_number' => $round,
                    'metadata' => [
                        'calculation' => 'field_size_and_stage',
                        'bracket_size' => $bracketSize,
                        'playoff_rounds' => $roundCount,
                    ],
                ];
            }
        } else {
            // Fallback for completed knockout tournaments that do not use our
            // playoff tables. Each completed match win is one advancement.
            foreach ($this->completedWins($tournamentId) as $playerId => $wins) {
                if (isset($rows[$playerId])) {
                    $rows[$playerId]['points'] = min($maximum, 1 + $wins);
                    $rows[$playerId]['stage_label'] = 'Sluttplassering';
                    $rows[$playerId]['stage_number'] = $wins;
                    $rows[$playerId]['metadata']['calculation'] = 'completed_match_wins_fallback';
                }
            }
        }

        $this->connection->begin_transaction();
        try {
            $upsert = $this->connection->prepare(sprintf(
                'INSERT INTO `%1$sseason_ranking_events`
                 (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at,reverted_at)
                 VALUES (?,?,?,?,?,?,?,"linear_v1","local",NULL,"applied",?,CURRENT_TIMESTAMP(6),NULL)
                 ON DUPLICATE KEY UPDATE
                    season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),
                    points=VALUES(points),source="local",source_reference=NULL,status="applied",metadata_json=VALUES(metadata_json),
                    applied_at=CURRENT_TIMESTAMP(6),reverted_at=NULL',
                $this->prefix
            ));
            foreach ($rows as $playerId => $row) {
                $stageLabel = (string) $row['stage_label'];
                $stageNumber = (int) $row['stage_number'];
                $points = (float) $row['points'];
                $metadata = json_encode($row['metadata'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}';
                $upsert->bind_param('iiiisids', $seasonId, $tournamentId, $playerId, $entrants, $stageLabel, $stageNumber, $points, $metadata);
                $upsert->execute();
            }
            $upsert->close();

            $ids = implode(',', array_map('intval', array_keys($rows)));
            if ($ids !== '') {
                $stmt = $this->connection->prepare(sprintf(
                    'UPDATE `%1$sseason_ranking_events`
                     SET status="reverted",reverted_at=CURRENT_TIMESTAMP(6)
                     WHERE tournament_id=? AND ruleset="linear_v1" AND player_id NOT IN (%2$s) AND status="applied"',
                    $this->prefix,
                    $ids
                ));
                $stmt->bind_param('i', $tournamentId);
                $stmt->execute();
                $stmt->close();
            }
            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /**
     * Used by the one-off history importer when the source exposes an explicit
     * event score. It remains idempotent and is replaced by a local calculation
     * if the tournament is later rebuilt natively.
     */
    public function applyImportedPoints(
        int $seasonId,
        int $tournamentId,
        int $playerId,
        int $entrants,
        float $points,
        ?string $stageLabel,
        ?int $stageNumber,
        string $sourceReference
    ): void {
        $metadata = json_encode(['calculation' => 'imported_explicit_points'], JSON_UNESCAPED_SLASHES) ?: '{}';
        $source = 'legacy_atlas';
        $ruleset = 'linear_v1';
        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$sseason_ranking_events`
             (season_id,tournament_id,player_id,entrants,stage_label,stage_number,points,ruleset,source,source_reference,status,metadata_json,applied_at,reverted_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,"applied",?,CURRENT_TIMESTAMP(6),NULL)
             ON DUPLICATE KEY UPDATE
                season_id=VALUES(season_id),entrants=VALUES(entrants),stage_label=VALUES(stage_label),stage_number=VALUES(stage_number),
                points=VALUES(points),source=VALUES(source),source_reference=VALUES(source_reference),status="applied",metadata_json=VALUES(metadata_json),
                applied_at=CURRENT_TIMESTAMP(6),reverted_at=NULL',
            $this->prefix
        ));
        $stmt->bind_param(
            'iiiisidssss',
            $seasonId,
            $tournamentId,
            $playerId,
            $entrants,
            $stageLabel,
            $stageNumber,
            $points,
            $ruleset,
            $source,
            $sourceReference,
            $metadata
        );
        $stmt->execute();
        $stmt->close();
    }

    public static function maximumPoints(int $entrants): int
    {
        if ($entrants <= 1) {
            return 1;
        }
        return 1 + (int) ceil(log($entrants, 2));
    }

    private function revertTournament(int $tournamentId): void
    {
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$sseason_ranking_events`
             SET status="reverted",reverted_at=CURRENT_TIMESTAMP(6)
             WHERE tournament_id=? AND ruleset="linear_v1" AND status="applied"',
            $this->prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $stmt->close();
    }

    /** @return array<string,mixed>|null */
    private function tournament(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT t.id,t.season_id,t.status,s.ranking_method
             FROM `%1$stournaments` t
             LEFT JOIN `%1$sseasons` s ON s.id=t.season_id
             WHERE t.id=? LIMIT 1',
            $this->prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return list<int> */
    private function participants(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT DISTINCT player_id FROM (
                SELECT player_a_id AS player_id FROM `%1$smatches` WHERE tournament_id=? AND status<>"cancelled"
                UNION
                SELECT player_b_id AS player_id FROM `%1$smatches` WHERE tournament_id=? AND status<>"cancelled"
             ) x WHERE player_id IS NOT NULL ORDER BY player_id',
            $this->prefix
        ));
        $stmt->bind_param('ii', $tournamentId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): int => (int) $row['player_id'], $rows);
    }

    /** @return array<string,mixed>|null */
    private function playoff(int $tournamentId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,bracket_size,status,champion_player_id FROM `%1$stournament_playoffs` WHERE tournament_id=? LIMIT 1',
            $this->prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return list<array{player_id:int,round_number:int,round_label:string}> */
    private function playoffProgress(int $playoffId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT e.player_id,
                    COALESCE(MAX(CASE WHEN n.player_a_id=e.player_id OR n.player_b_id=e.player_id OR n.winner_player_id=e.player_id THEN n.round_number END),1) AS round_number,
                    SUBSTRING_INDEX(GROUP_CONCAT(
                        CASE WHEN n.player_a_id=e.player_id OR n.player_b_id=e.player_id OR n.winner_player_id=e.player_id THEN n.round_label END
                        ORDER BY n.round_number DESC SEPARATOR "||"
                    ),"||",1) AS round_label
             FROM `%1$stournament_playoff_entries` e
             LEFT JOIN `%1$stournament_playoff_nodes` n ON n.playoff_id=e.playoff_id
             WHERE e.playoff_id=?
             GROUP BY e.player_id',
            $this->prefix
        ));
        $stmt->bind_param('i', $playoffId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn (array $row): array => [
            'player_id' => (int) $row['player_id'],
            'round_number' => (int) $row['round_number'],
            'round_label' => (string) ($row['round_label'] ?? 'Sluttspill'),
        ], $rows);
    }

    /** @return array<int,int> */
    private function completedWins(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT winner_player_id,COUNT(*) AS wins FROM `%1$smatches`
             WHERE tournament_id=? AND status="completed" AND winner_player_id IS NOT NULL
             GROUP BY winner_player_id',
            $this->prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $result = [];
        foreach ($rows as $row) {
            $result[(int) $row['winner_player_id']] = (int) $row['wins'];
        }
        return $result;
    }
}
