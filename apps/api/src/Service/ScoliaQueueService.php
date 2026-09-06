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
 * Events are prioritized between boards, but FIFO is absolute within each board:
 * only the oldest unresolved event for a kiosk is eligible for claiming. A dead
 * letter therefore pauses that board without blocking other boards.
 */
final class ScoliaQueueService
{
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
    public function drain(int $limit = 25, ?array $kioskIds = null): array
    {
        $events = $this->claimEvents($limit, $kioskIds);
        $processed = 0;
        $failed = 0;

        foreach ($events as $event) {
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
            }
        }

        return ['claimed' => count($events), 'processed' => $processed, 'failed' => $failed];
    }

    /**
     * Return at most one head event per kiosk. Priority decides which kiosk heads
     * run first; the NOT EXISTS guard prevents later events from overtaking an
     * older queued, failed, processing or dead-letter event on the same board.
     *
     * @param array<int,int>|null $kioskIds
     * @return array<int,array<string,mixed>>
     */
    private function claimEvents(int $limit, ?array $kioskIds = null): array
    {
        $limit = min(100, max(1, $limit));
        $rows = [];
        $eventsTable = $this->tablePrefix . 'scolia_events';

        $scopeSql = '';
        if ($kioskIds !== null) {
            $kioskIds = array_values(array_unique(array_filter(
                array_map('intval', $kioskIds),
                static fn(int $id): bool => $id > 0
            )));
            if ($kioskIds === []) return [];
            $scopeSql = ' AND kiosk_id IN (' . implode(',', $kioskIds) . ')';
        }

        $this->connection->begin_transaction();
        try {
            // A PHP/worker crash after claiming must not strand a row forever.
            $this->connection->query(sprintf(
                'UPDATE `%1$s`
                 SET processing_status="failed",next_attempt_at=NOW(3),
                     last_error=COALESCE(last_error,"Recovered stale Scolia processing lease")
                 WHERE processing_status="processing"
                   AND processing_started_at IS NOT NULL
                   AND processing_started_at < DATE_SUB(NOW(3), INTERVAL 60 SECOND)%2$s',
                $eventsTable,
                $scopeSql
            ));

            $candidateScopeSql = '';
            if ($kioskIds !== null) {
                $candidateScopeSql = ' AND e.kiosk_id IN (' . implode(',', $kioskIds) . ')';
            }
            $sql = sprintf(
                'SELECT e.* FROM `%1$s` e
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
                $candidateScopeSql
            );
            $result = $this->connection->query($sql);
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
