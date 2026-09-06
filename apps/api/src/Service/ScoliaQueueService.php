<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

/**
 * Coordinates asynchronous Scolia work.
 *
 * Events are prioritized between boards, but FIFO is absolute within each board.
 * The worker claims a bounded FIFO prefix from several boards in one transaction,
 * then processes each board sequentially. If one event fails, later claimed rows
 * for that board are released without consuming an attempt.
 */
final class ScoliaQueueService
{
    private const MAX_DRAIN_BATCH = 25;
    private const DEFAULT_DRAIN_BUDGET_MS = 750;

    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(
        Database $database,
        private readonly ScoliaRepository $repository,
        private readonly ScoliaScoringService $processor
    ) {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @param array<int,int>|null $kioskIds Optional explicit queue scope. Production
     *        workers omit it; diagnostics/tests use it to avoid claiming unrelated work.
     * @return array{claimed:int,processed:int,failed:int}
     */
    public function drain(int $limit = 25, ?array $kioskIds = null, int $maxProcessingMs = self::DEFAULT_DRAIN_BUDGET_MS): array
    {
        // A bridge/API caller must never reserve a large queue prefix and hold one
        // scarce database slot for several seconds. Old bridge versions may still
        // request 100 rows, so enforce the production-safe batch size here too.
        $limit = min(self::MAX_DRAIN_BATCH, max(1, $limit));
        $maxProcessingMs = min(5000, max(100, $maxProcessingMs));
        $startedAt = microtime(true);

        $events = $this->claimEvents($limit, $kioskIds);
        if ($events === []) {
            return ['claimed' => 0, 'processed' => 0, 'failed' => 0];
        }

        $processed = 0;
        $failed = 0;
        $fastIgnoredIds = [];
        $releaseIds = [];
        $byKiosk = [];
        $budgetExhausted = false;

        foreach ($events as $event) {
            $byKiosk[(int) $event['kiosk_id']][] = $event;
        }

        foreach ($byKiosk as $boardEvents) {
            $blocked = false;
            foreach ($boardEvents as $event) {
                // The budget is cooperative: never interrupt an event while its
                // canonical scoring transaction is running. Instead, stop between
                // events and release every unprocessed claim without consuming a
                // retry. This preserves FIFO while giving other web requests a turn.
                if (!$budgetExhausted) {
                    $elapsedMs = (microtime(true) - $startedAt) * 1000;
                    if ($elapsedMs >= $maxProcessingMs) {
                        $budgetExhausted = true;
                    }
                }

                if ($blocked || $budgetExhausted) {
                    $releaseIds[] = (int) $event['id'];
                    continue;
                }

                // Disabled boards do not need a full repository lookup for ordinary
                // Scolia payloads. The club-id equality guard deliberately prevents
                // diagnostics/poison rows from bypassing normal validation.
                if ($this->canFastIgnoreDisabledBoardEvent($event)) {
                    $fastIgnoredIds[] = (int) $event['id'];
                    $processed++;
                    continue;
                }

                try {
                    $result = $this->processor->processEvent($event);
                    $this->repository->markEventProcessed(
                        (int) $event['id'],
                        (string) ($result['status'] ?? 'processed'),
                        isset($result['visit_id']) ? (int) $result['visit_id'] : null,
                        $result['meta'] ?? null
                    );
                    $processed++;
                } catch (Throwable $error) {
                    $this->repository->markEventFailed($event, $error);
                    $failed++;
                    $blocked = true;
                }
            }
        }

        if ($fastIgnoredIds !== []) {
            $this->markDisabledBoardEventsIgnored($fastIgnoredIds);
        }
        if ($releaseIds !== []) {
            $this->releaseUnprocessedClaims($releaseIds);
        }

        return ['claimed' => count($events), 'processed' => $processed, 'failed' => $failed];
    }

    /** @param array<string,mixed> $event */
    private function canFastIgnoreDisabledBoardEvent(array $event): bool
    {
        if ((string) ($event['queue_board_mode'] ?? '') !== 'off') return false;
        if ((int) ($event['club_id'] ?? 0) !== (int) ($event['queue_kiosk_club_id'] ?? -1)) return false;

        $type = strtoupper((string) ($event['event_type'] ?? 'UNKNOWN'));
        return !in_array($type, ['BRIDGE_CONNECTED', 'BRIDGE_DISCONNECTED', 'BRIDGE_ERROR'], true);
    }

    /** @param array<int,int> $eventIds */
    private function markDisabledBoardEventsIgnored(array $eventIds): void
    {
        $eventIds = array_values(array_unique(array_filter(array_map('intval', $eventIds), static fn(int $id): bool => $id > 0)));
        if ($eventIds === []) return;

        $meta = $this->connection->real_escape_string((string) json_encode(
            ['reason' => 'scolia_disabled_for_board'],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        ));
        $this->connection->query(sprintf(
            'UPDATE `%1$s` SET processing_status="ignored",processed_at=NOW(3),last_error=NULL,
                    canonical_visit_id=NULL,processing_meta_json="%3$s",processing_started_at=NULL
             WHERE id IN (%2$s) AND processing_status="processing"',
            $this->tablePrefix . 'scolia_events',
            implode(',', $eventIds),
            $meta
        ));
    }

    /** @param array<int,int> $eventIds */
    private function releaseUnprocessedClaims(array $eventIds): void
    {
        $eventIds = array_values(array_unique(array_filter(array_map('intval', $eventIds), static fn(int $id): bool => $id > 0)));
        if ($eventIds === []) return;

        $this->connection->query(sprintf(
            'UPDATE `%1$s` SET processing_status="queued",attempt_count=GREATEST(0,attempt_count-1),processing_started_at=NULL
             WHERE id IN (%2$s) AND processing_status="processing"',
            $this->tablePrefix . 'scolia_events',
            implode(',', $eventIds)
        ));
    }

    /**
     * Claim a FIFO prefix from each currently eligible board. The first query
     * chooses board heads by priority; the second query claims a fair share of
     * consecutive ready rows from those boards. This collapses many per-event
     * queue round-trips while preserving strict ordering within every kiosk.
     *
     * @param array<int,int>|null $kioskIds
     * @return array<int,array<string,mixed>>
     */
    private function claimEvents(int $limit, ?array $kioskIds = null): array
    {
        $limit = min(100, max(1, $limit));
        $rows = [];
        $eventsTable = $this->tablePrefix . 'scolia_events';
        $kiosksTable = $this->tablePrefix . 'kiosks';
        $settingsTable = $this->tablePrefix . 'scolia_board_settings';

        $scopeIds = null;
        $scopeSql = '';
        if ($kioskIds !== null) {
            $scopeIds = array_values(array_unique(array_filter(
                array_map('intval', $kioskIds),
                static fn(int $id): bool => $id > 0
            )));
            if ($scopeIds === []) return [];
            $scopeSql = ' AND e.kiosk_id IN (' . implode(',', $scopeIds) . ')';
        }

        $this->connection->begin_transaction();
        try {
            // A PHP/worker crash after claiming must not strand a row forever.
            $staleScopeSql = $scopeIds === null ? '' : ' AND kiosk_id IN (' . implode(',', $scopeIds) . ')';
            $this->connection->query(sprintf(
                'UPDATE `%1$s`
                 SET processing_status="failed",next_attempt_at=NOW(3),processing_started_at=NULL,
                     last_error=COALESCE(last_error,"Recovered stale Scolia processing lease")
                 WHERE processing_status="processing"
                   AND processing_started_at IS NOT NULL
                   AND processing_started_at < DATE_SUB(NOW(3), INTERVAL 60 SECOND)%2$s',
                $eventsTable,
                $staleScopeSql
            ));

            // First pick eligible board heads. Priority is applied only between
            // boards; later events can never overtake their own board head.
            $headResult = $this->connection->query(sprintf(
                'SELECT e.kiosk_id,e.id,e.priority
                 FROM `%1$s` e
                 WHERE e.processing_status IN ("queued","failed")
                   AND e.next_attempt_at<=NOW(3)%3$s
                   AND NOT EXISTS (
                       SELECT 1 FROM `%1$s` older
                       WHERE older.kiosk_id=e.kiosk_id
                         AND older.id<e.id
                         AND older.processing_status IN ("queued","failed","processing","dead_letter")
                   )
                 ORDER BY e.priority DESC,e.id ASC
                 LIMIT %2$d FOR UPDATE',
                $eventsTable,
                $limit,
                $scopeSql
            ));
            $heads = $headResult->fetch_all(MYSQLI_ASSOC);
            if ($heads === []) {
                $this->connection->commit();
                return [];
            }

            $orderedKioskIds = array_values(array_map(static fn(array $row): int => (int) $row['kiosk_id'], $heads));
            $perBoard = max(1, intdiv($limit, count($orderedKioskIds)));
            $idsSql = implode(',', $orderedKioskIds);

            // Only claim a ready FIFO prefix. A processing/dead-letter row or a
            // failed row whose retry time has not arrived blocks every later row.
            $result = $this->connection->query(sprintf(
                'SELECT e.*,
                        COALESCE(s.mode,IF(k.scoring_mode="scolia","live","off")) AS queue_board_mode,
                        k.club_id AS queue_kiosk_club_id
                 FROM `%1$s` e
                 INNER JOIN `%2$s` k ON k.id=e.kiosk_id
                 LEFT JOIN `%3$s` s ON s.kiosk_id=e.kiosk_id
                 WHERE e.kiosk_id IN (%4$s)
                   AND e.processing_status IN ("queued","failed")
                   AND e.next_attempt_at<=NOW(3)
                   AND NOT EXISTS (
                       SELECT 1 FROM `%1$s` blocker
                       WHERE blocker.kiosk_id=e.kiosk_id
                         AND blocker.id<e.id
                         AND (
                             blocker.processing_status IN ("processing","dead_letter")
                             OR (blocker.processing_status IN ("queued","failed") AND blocker.next_attempt_at>NOW(3))
                         )
                   )
                   AND (
                       SELECT COUNT(*) FROM `%1$s` older
                       WHERE older.kiosk_id=e.kiosk_id
                         AND older.id<e.id
                         AND older.processing_status IN ("queued","failed","processing","dead_letter")
                   ) < %5$d
                 ORDER BY FIELD(e.kiosk_id,%4$s),e.id ASC
                 FOR UPDATE',
                $eventsTable,
                $kiosksTable,
                $settingsTable,
                $idsSql,
                $perBoard
            ));
            $rows = $result->fetch_all(MYSQLI_ASSOC);

            if ($rows !== []) {
                $ids = implode(',', array_map(static fn(array $row): int => (int) $row['id'], $rows));
                $this->connection->query(sprintf(
                    'UPDATE `%1$s`
                     SET processing_status="processing",attempt_count=attempt_count+1,processing_started_at=NOW(3)
                     WHERE id IN (%2$s)',
                    $eventsTable,
                    $ids
                ));
            }
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        foreach ($rows as &$row) {
            $row['payload'] = json_decode((string) ($row['payload_json'] ?? '{}'), true) ?: [];
            $row['attempt_count'] = (int) ($row['attempt_count'] ?? 0) + 1;
            $row['priority'] = (int) ($row['priority'] ?? 50);
            $row['queue_kiosk_club_id'] = (int) ($row['queue_kiosk_club_id'] ?? 0);
        }
        unset($row);
        return $rows;
    }

    /**
     * Claim commands for many connected boards in one DB transaction. Only one
     * outstanding command per kiosk is delivered at a time, preserving FIFO.
     *
     * @param array<int,int> $kioskIds
     * @return array<int,array<string,mixed>>
     */
    public function pollCommands(array $kioskIds, int $limit = 100): array
    {
        $kioskIds = array_values(array_unique(array_filter(
            array_map('intval', $kioskIds),
            static fn(int $id): bool => $id > 0
        )));
        $kioskIds = array_slice($kioskIds, 0, 100);
        if ($kioskIds === []) return [];

        $limit = min(200, max(1, $limit));
        $idsSql = implode(',', $kioskIds);
        $commandsTable = $this->tablePrefix . 'scolia_commands';
        $rows = [];

        $this->connection->begin_transaction();
        try {
            // If a bridge disappears after a command was handed out, make the
            // command eligible for retry instead of leaving it delivered forever.
            $this->connection->query(sprintf(
                'UPDATE `%1$s`
                 SET status="failed",next_attempt_at=NOW(3),last_error=COALESCE(last_error,"Recovered stale command delivery")
                 WHERE kiosk_id IN (%2$s) AND status="delivered"
                   AND delivered_at < DATE_SUB(NOW(3), INTERVAL 30 SECOND)',
                $commandsTable,
                $idsSql
            ));

            $result = $this->connection->query(sprintf(
                'SELECT c.id,c.kiosk_id,c.command_type,c.message_id,c.payload_json,c.attempt_count,c.priority,c.created_at
                 FROM `%1$s` c
                 WHERE c.kiosk_id IN (%2$s)
                   AND c.status IN ("queued","failed")
                   AND c.next_attempt_at<=NOW(3)
                   AND NOT EXISTS (
                       SELECT 1 FROM `%1$s` older
                       WHERE older.kiosk_id=c.kiosk_id
                         AND older.id<c.id
                         AND older.status IN ("queued","failed","delivered")
                   )
                 ORDER BY c.priority DESC,c.id ASC
                 LIMIT %3$d FOR UPDATE',
                $commandsTable,
                $idsSql,
                $limit
            ));
            $rows = $result->fetch_all(MYSQLI_ASSOC);

            if ($rows !== []) {
                $commandIds = implode(',', array_map(static fn(array $row): int => (int) $row['id'], $rows));
                $this->connection->query(sprintf(
                    'UPDATE `%1$s`
                     SET status="delivered",attempt_count=attempt_count+1,delivered_at=NOW(3)
                     WHERE id IN (%2$s)',
                    $commandsTable,
                    $commandIds
                ));
            }
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['kiosk_id'] = (int) $row['kiosk_id'];
            $row['attempt_count'] = (int) $row['attempt_count'] + 1;
            $row['priority'] = (int) ($row['priority'] ?? 50);
            $row['payload'] = json_decode((string) ($row['payload_json'] ?? '{}'), true) ?: [];
            unset($row['payload_json']);
        }
        unset($row);
        return $rows;
    }
}
