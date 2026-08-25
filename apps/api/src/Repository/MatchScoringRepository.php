<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class MatchScoringRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private Dart501Rules $rules;

    public function __construct(Database $database, ?Dart501Rules $rules = null)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->rules = $rules ?? new Dart501Rules();
    }

    public function startMatch(int $kioskId): void
    {
        $this->transaction(function () use ($kioskId): void {
            $match = $this->findActiveMatchForKiosk($kioskId, false, true);
            if ($match === null) {
                return;
            }

            if ((string) $match['status'] === 'assigned') {
                $sql = sprintf(
                    'UPDATE `%1$smatches` SET status="in_progress", starts_at=COALESCE(starts_at, NOW()) WHERE id=?',
                    $this->tablePrefix
                );
                $stmt = $this->connection->prepare($sql);
                $matchId = (int) $match['id'];
                $stmt->bind_param('i', $matchId);
                $stmt->execute();
                $stmt->close();
            }

            $this->ensureCurrentLeg($match);
        });
    }

    /** @param array<string, mixed> $payload */
    public function recordVisit(int $kioskId, array $payload): void
    {
        $this->transaction(function () use ($kioskId, $payload): void {
            $match = $this->findActiveMatchForKiosk($kioskId, false, true);
            if ($match === null) {
                throw new ValidationException('match_not_available', 'Det finnes ingen kamp klar på denne skiven.', 409);
            }

            if ((string) $match['status'] === 'assigned') {
                $sql = sprintf(
                    'UPDATE `%1$smatches` SET status="in_progress", starts_at=COALESCE(starts_at, NOW()) WHERE id=?',
                    $this->tablePrefix
                );
                $stmt = $this->connection->prepare($sql);
                $matchId = (int) $match['id'];
                $stmt->bind_param('i', $matchId);
                $stmt->execute();
                $stmt->close();
                $match['status'] = 'in_progress';
            }

            $leg = $this->ensureCurrentLeg($match);
            $currentPlayerId = $this->determineCurrentPlayerId($match, (int) $leg['id']);
            $remaining = $this->calculateRemainingScores($match, $leg);
            $remainingBefore = $remaining[$currentPlayerId] ?? (int) $leg['start_score'];
            $visit = $this->rules->evaluateVisit($remainingBefore, $payload);

            $requestKey = trim((string) ($payload['request_id'] ?? ''));
            if ($requestKey !== '') {
                if (strlen($requestKey) > 80) {
                    throw new ValidationException('request_id_too_long', 'request_id er for lang.');
                }
                if ($this->visitRequestAlreadyExists($requestKey)) {
                    return;
                }
            } else {
                $requestKey = null;
            }

            $visitNumber = $this->nextVisitNumberForPlayer((int) $leg['id'], $currentPlayerId);
            $dartsJson = $visit['darts'] !== []
                ? json_encode($visit['darts'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                : null;
            $bust = $visit['is_bust'] ? 1 : 0;
            $matchId = (int) $match['id'];
            $legId = (int) $leg['id'];
            $score = (int) $visit['score'];
            $dartsUsed = (int) $visit['darts_used'];
            $inputMode = (string) $visit['input_mode'];
            $remainingAfter = (int) $visit['remaining_after'];

            $sql = sprintf(
                'INSERT INTO `%1$svisits`
                 (match_id, leg_id, player_id, visit_number, score, darts_used, input_mode, darts_json, is_bust, remaining_after, request_key)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                $this->tablePrefix
            );
            $stmt = $this->connection->prepare($sql);
            $stmt->bind_param(
                'iiiiiissiis',
                $matchId,
                $legId,
                $currentPlayerId,
                $visitNumber,
                $score,
                $dartsUsed,
                $inputMode,
                $dartsJson,
                $bust,
                $remainingAfter,
                $requestKey
            );
            $stmt->execute();
            $stmt->close();

            if ($visit['is_checkout']) {
                $this->completeLeg($match, $leg, $currentPlayerId);
            }

            $this->rebuildMatchStatistics($matchId);
        });
    }

    public function undoLastVisit(int $kioskId): void
    {
        $this->transaction(function () use ($kioskId): void {
            $match = $this->findActiveMatchForKiosk($kioskId, true, true);
            if ($match === null) {
                return;
            }

            $matchId = (int) $match['id'];
            $this->removeTrailingEmptyLegs($matchId);
            $leg = $this->findLatestLeg($matchId, true);
            if ($leg === null) {
                return;
            }

            $visit = $this->findLatestVisit((int) $leg['id'], true);
            if ($visit === null) {
                return;
            }

            if ((string) $leg['status'] === 'completed') {
                $sql = sprintf(
                    'UPDATE `%1$slegs` SET winner_player_id=NULL, status="in_progress", finished_at=NULL WHERE id=?',
                    $this->tablePrefix
                );
                $stmt = $this->connection->prepare($sql);
                $legId = (int) $leg['id'];
                $stmt->bind_param('i', $legId);
                $stmt->execute();
                $stmt->close();
            }

            if ((string) $match['status'] === 'completed') {
                $sql = sprintf(
                    'UPDATE `%1$smatches` SET status="in_progress", winner_player_id=NULL, finished_at=NULL WHERE id=?',
                    $this->tablePrefix
                );
                $stmt = $this->connection->prepare($sql);
                $stmt->bind_param('i', $matchId);
                $stmt->execute();
                $stmt->close();
            }

            $sql = sprintf('DELETE FROM `%1$svisits` WHERE id=?', $this->tablePrefix);
            $stmt = $this->connection->prepare($sql);
            $visitId = (int) $visit['id'];
            $stmt->bind_param('i', $visitId);
            $stmt->execute();
            $stmt->close();

            $this->rebuildMatchStatistics($matchId);
        });
    }

    /** @return array<string, mixed>|null */
    private function findActiveMatchForKiosk(int $kioskId, bool $includeCompleted, bool $forUpdate): ?array
    {
        $statuses = $includeCompleted
            ? '("in_progress","assigned","completed")'
            : '("in_progress","assigned")';
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $sql = sprintf(
            'SELECT id, tournament_id, kiosk_id, status, best_of_legs, legs_to_win,
                    player_a_id, player_b_id, winner_player_id, starts_at, finished_at
             FROM `%1$smatches`
             WHERE kiosk_id=? AND status IN %2$s
             ORDER BY FIELD(status,"in_progress","assigned","completed"), id ASC
             LIMIT 1%3$s',
            $this->tablePrefix,
            $statuses,
            $lock
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string, mixed> $match @return array<string, mixed> */
    private function ensureCurrentLeg(array $match): array
    {
        $matchId = (int) $match['id'];
        $leg = $this->findOpenLeg($matchId, true);
        if ($leg !== null) {
            if ((string) $leg['status'] === 'pending') {
                $sql = sprintf('UPDATE `%1$slegs` SET status="in_progress" WHERE id=?', $this->tablePrefix);
                $stmt = $this->connection->prepare($sql);
                $legId = (int) $leg['id'];
                $stmt->bind_param('i', $legId);
                $stmt->execute();
                $stmt->close();
                $leg['status'] = 'in_progress';
            }
            return $leg;
        }

        $latest = $this->findLatestLeg($matchId, true);
        $legNumber = $latest === null ? 1 : ((int) $latest['leg_number']) + 1;
        $startingPlayerId = (int) $match['player_a_id'];
        if ($latest !== null) {
            $startingPlayerId = (int) $latest['starting_player_id'] === (int) $match['player_a_id']
                ? (int) $match['player_b_id']
                : (int) $match['player_a_id'];
        }

        $startScore = 501;
        $sql = sprintf(
            'INSERT INTO `%1$slegs` (match_id, leg_number, starting_player_id, status, start_score)
             VALUES (?, ?, ?, "in_progress", ?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiii', $matchId, $legNumber, $startingPlayerId, $startScore);
        $stmt->execute();
        $legId = (int) $stmt->insert_id;
        $stmt->close();

        return [
            'id' => $legId,
            'match_id' => $matchId,
            'leg_number' => $legNumber,
            'starting_player_id' => $startingPlayerId,
            'status' => 'in_progress',
            'start_score' => $startScore,
        ];
    }

    /** @return array<string, mixed>|null */
    private function findOpenLeg(int $matchId, bool $forUpdate): ?array
    {
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $sql = sprintf(
            'SELECT id, match_id, leg_number, starting_player_id, status, start_score
             FROM `%1$slegs`
             WHERE match_id=? AND status IN ("pending","in_progress")
             ORDER BY leg_number DESC LIMIT 1%2$s',
            $this->tablePrefix,
            $lock
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string, mixed>|null */
    private function findLatestLeg(int $matchId, bool $forUpdate): ?array
    {
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $sql = sprintf(
            'SELECT id, match_id, leg_number, starting_player_id, status, start_score, winner_player_id
             FROM `%1$slegs` WHERE match_id=? ORDER BY leg_number DESC LIMIT 1%2$s',
            $this->tablePrefix,
            $lock
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<string, mixed>|null */
    private function findLatestVisit(int $legId, bool $forUpdate): ?array
    {
        $lock = $forUpdate ? ' FOR UPDATE' : '';
        $sql = sprintf(
            'SELECT id, leg_id, player_id, score, darts_used, is_bust, remaining_after
             FROM `%1$svisits` WHERE leg_id=? ORDER BY id DESC LIMIT 1%2$s',
            $this->tablePrefix,
            $lock
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $legId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string, mixed> $match @param array<string, mixed> $leg @return array<int,int> */
    private function calculateRemainingScores(array $match, array $leg): array
    {
        $startScore = (int) ($leg['start_score'] ?? 501);
        $remaining = [
            (int) $match['player_a_id'] => $startScore,
            (int) $match['player_b_id'] => $startScore,
        ];

        $sql = sprintf(
            'SELECT player_id, score, is_bust FROM `%1$svisits` WHERE leg_id=? ORDER BY id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $legId = (int) $leg['id'];
        $stmt->bind_param('i', $legId);
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            if ((int) $row['is_bust'] === 1) {
                continue;
            }
            $playerId = (int) $row['player_id'];
            $remaining[$playerId] = ($remaining[$playerId] ?? $startScore) - (int) $row['score'];
        }
        $stmt->close();
        return $remaining;
    }

    /** @param array<string, mixed> $match */
    private function determineCurrentPlayerId(array $match, int $legId): int
    {
        $sql = sprintf(
            'SELECT l.starting_player_id, COUNT(v.id) AS total_visits
             FROM `%1$slegs` l
             LEFT JOIN `%1$svisits` v ON v.leg_id=l.id
             WHERE l.id=? GROUP BY l.id, l.starting_player_id',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $legId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            throw new ValidationException('leg_not_found', 'Aktivt leg ble ikke funnet.', 409);
        }

        $starter = (int) $row['starting_player_id'];
        $other = $starter === (int) $match['player_a_id']
            ? (int) $match['player_b_id']
            : (int) $match['player_a_id'];
        return ((int) $row['total_visits'] % 2 === 0) ? $starter : $other;
    }

    private function nextVisitNumberForPlayer(int $legId, int $playerId): int
    {
        $sql = sprintf(
            'SELECT COALESCE(MAX(visit_number),0) AS n FROM `%1$svisits` WHERE leg_id=? AND player_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $legId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: ['n' => 0];
        $stmt->close();
        return ((int) $row['n']) + 1;
    }

    /** @param array<string, mixed> $match @param array<string, mixed> $leg */
    private function completeLeg(array $match, array $leg, int $winnerPlayerId): void
    {
        $legId = (int) $leg['id'];
        $sql = sprintf(
            'UPDATE `%1$slegs` SET winner_player_id=?, status="completed", finished_at=NOW() WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $winnerPlayerId, $legId);
        $stmt->execute();
        $stmt->close();

        $wins = $this->countLegWins((int) $match['id'], $winnerPlayerId);
        if ($wins >= (int) $match['legs_to_win']) {
            $sql = sprintf(
                'UPDATE `%1$smatches` SET status="completed", winner_player_id=?, finished_at=NOW() WHERE id=?',
                $this->tablePrefix
            );
            $stmt = $this->connection->prepare($sql);
            $matchId = (int) $match['id'];
            $stmt->bind_param('ii', $winnerPlayerId, $matchId);
            $stmt->execute();
            $stmt->close();
            return;
        }

        $this->ensureCurrentLeg($match);
    }

    private function countLegWins(int $matchId, int $playerId): int
    {
        $sql = sprintf(
            'SELECT COUNT(*) AS c FROM `%1$slegs` WHERE match_id=? AND winner_player_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $matchId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: ['c' => 0];
        $stmt->close();
        return (int) $row['c'];
    }

    private function removeTrailingEmptyLegs(int $matchId): void
    {
        while (true) {
            $leg = $this->findLatestLeg($matchId, true);
            if ($leg === null) {
                return;
            }
            $sql = sprintf('SELECT COUNT(*) AS c FROM `%1$svisits` WHERE leg_id=?', $this->tablePrefix);
            $stmt = $this->connection->prepare($sql);
            $legId = (int) $leg['id'];
            $stmt->bind_param('i', $legId);
            $stmt->execute();
            $count = (int) (($stmt->get_result()->fetch_assoc()['c'] ?? 0));
            $stmt->close();
            if ($count > 0) {
                return;
            }
            $sql = sprintf('DELETE FROM `%1$slegs` WHERE id=?', $this->tablePrefix);
            $stmt = $this->connection->prepare($sql);
            $stmt->bind_param('i', $legId);
            $stmt->execute();
            $stmt->close();
        }
    }

    private function visitRequestAlreadyExists(string $requestKey): bool
    {
        $sql = sprintf('SELECT id FROM `%1$svisits` WHERE request_key=? LIMIT 1', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('s', $requestKey);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    }

    private function rebuildMatchStatistics(int $matchId): void
    {
        $sql = sprintf(
            'SELECT player_a_id, player_b_id FROM `%1$smatches` WHERE id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($match === null) {
            return;
        }

        foreach ([(int) $match['player_a_id'], (int) $match['player_b_id']] as $playerId) {
            $aggregateSql = sprintf(
                'SELECT
                    COALESCE(SUM(CASE WHEN is_bust=0 THEN score ELSE 0 END),0) AS effective_score,
                    COALESCE(SUM(darts_used),0) AS darts_thrown,
                    COALESCE(MAX(CASE WHEN is_bust=0 AND remaining_after=0 THEN score END),0) AS highest_checkout,
                    SUM(CASE WHEN is_bust=0 AND score>=100 AND score<140 THEN 1 ELSE 0 END) AS score_100_plus,
                    SUM(CASE WHEN is_bust=0 AND score>=140 AND score<180 THEN 1 ELSE 0 END) AS score_140_plus,
                    SUM(CASE WHEN is_bust=0 AND score=180 THEN 1 ELSE 0 END) AS score_180
                 FROM `%1$svisits` WHERE match_id=? AND player_id=?',
                $this->tablePrefix
            );
            $aggregate = $this->connection->prepare($aggregateSql);
            $aggregate->bind_param('ii', $matchId, $playerId);
            $aggregate->execute();
            $row = $aggregate->get_result()->fetch_assoc() ?: [];
            $aggregate->close();

            $legsSql = sprintf(
                'SELECT COUNT(*) AS c FROM `%1$slegs` WHERE match_id=? AND winner_player_id=?',
                $this->tablePrefix
            );
            $legsStmt = $this->connection->prepare($legsSql);
            $legsStmt->bind_param('ii', $matchId, $playerId);
            $legsStmt->execute();
            $legsWon = (int) (($legsStmt->get_result()->fetch_assoc()['c'] ?? 0));
            $legsStmt->close();

            $dartsThrown = (int) ($row['darts_thrown'] ?? 0);
            $effectiveScore = (int) ($row['effective_score'] ?? 0);
            $average = $dartsThrown > 0 ? round(($effectiveScore / $dartsThrown) * 3, 2) : null;
            $highestCheckout = (int) ($row['highest_checkout'] ?? 0);
            $score100 = (int) ($row['score_100_plus'] ?? 0);
            $score140 = (int) ($row['score_140_plus'] ?? 0);
            $score180 = (int) ($row['score_180'] ?? 0);
            $checkoutHits = $legsWon;
            $checkoutAttempts = null;

            $upsertSql = sprintf(
                'INSERT INTO `%1$smatch_statistics`
                 (match_id, player_id, legs_won, average, darts_thrown, checkout_hits, checkout_attempts,
                  highest_checkout, score_100_plus, score_140_plus, score_180)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    legs_won=VALUES(legs_won), average=VALUES(average), darts_thrown=VALUES(darts_thrown),
                    checkout_hits=VALUES(checkout_hits), checkout_attempts=VALUES(checkout_attempts),
                    highest_checkout=VALUES(highest_checkout), score_100_plus=VALUES(score_100_plus),
                    score_140_plus=VALUES(score_140_plus), score_180=VALUES(score_180), updated_at=NOW()',
                $this->tablePrefix
            );
            $upsert = $this->connection->prepare($upsertSql);
            $upsert->bind_param(
                'iiidiiiiiii',
                $matchId,
                $playerId,
                $legsWon,
                $average,
                $dartsThrown,
                $checkoutHits,
                $checkoutAttempts,
                $highestCheckout,
                $score100,
                $score140,
                $score180
            );
            $upsert->execute();
            $upsert->close();
        }
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
