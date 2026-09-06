<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaQueueService;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') {
    exit(2);
}

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$p = $database->tablePrefix();

if ($p !== 'bd_test_') {
    throw new RuntimeException('Virtual Scolia queue test is TEST-only and refuses table prefix: ' . $p);
}

$assert = static function (bool $ok, string $message): void {
    if (!$ok) throw new RuntimeException($message);
};

$scalar = static function (mysqli $db, string $sql): int {
    $result = $db->query($sql);
    $row = $result->fetch_row();
    return (int) ($row[0] ?? 0);
};

$suffix = strtolower(substr(bin2hex(random_bytes(8)), 0, 12));
$lockName = $p . 'scolia-queue-virtual-test';
$lockHeld = false;
$clubId = 0;
$poisonClubId = 0;
$kioskIds = [];
$serials = [];
$eventIds = [];
$duplicateCount = 0;
$startedAt = microtime(true);

$stmt = $db->prepare('SELECT GET_LOCK(?, 120) AS locked');
$stmt->bind_param('s', $lockName);
$stmt->execute();
$lockHeld = (int) ($stmt->get_result()->fetch_assoc()['locked'] ?? 0) === 1;
$stmt->close();
$assert($lockHeld, 'Could not acquire isolated virtual Scolia queue test lock.');

try {
    $name = 'Scolia Virtual Queue ' . $suffix;
    $slug = 'scolia-virtual-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)', $p));
    $stmt->bind_param('ss', $name, $slug);
    $stmt->execute();
    $clubId = (int) $stmt->insert_id;
    $stmt->close();

    $poisonName = 'Scolia Poison ' . $suffix;
    $poisonSlug = 'scolia-poison-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)', $p));
    $stmt->bind_param('ss', $poisonName, $poisonSlug);
    $stmt->execute();
    $poisonClubId = (int) $stmt->insert_id;
    $stmt->close();

    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$sscolia_club_settings` (club_id,enabled,access_token,queue_max_attempts,queue_retry_base_seconds) VALUES (?,0,?,8,1)',
        $p
    ));
    $virtualToken = 'virtual-test';
    $stmt->bind_param('is', $clubId, $virtualToken);
    $stmt->execute();
    $stmt->close();

    for ($board = 1; $board <= 10; $board++) {
        $code = sprintf('VQ-%s-%02d', strtoupper($suffix), $board);
        $boardName = 'Virtual Scolia ' . $board;
        $boardNumber = 9900 + $board;
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$skiosks` (club_id,code,name,board_number,scoring_mode) VALUES (?,?,?, ?,"scolia")',
            $p
        ));
        $stmt->bind_param('issi', $clubId, $code, $boardName, $boardNumber);
        $stmt->execute();
        $kioskId = (int) $stmt->insert_id;
        $stmt->close();
        $kioskIds[$board] = $kioskId;

        $serial = sprintf('VIRTUAL-%s-%02d', strtoupper($suffix), $board);
        $serials[$board] = $serial;
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$sscolia_board_settings` (kiosk_id,serial_number,mode,auto_fallback_to_manual) VALUES (?, ?,"off",1)',
            $p
        ));
        $stmt->bind_param('is', $kioskId, $serial);
        $stmt->execute();
        $stmt->close();
    }

    $repository = new ScoliaRepository($database);
    $scoring = new CanonicalScoringService($database);
    $processor = new ScoliaScoringService($repository, $scoring, new Dart501Rules());
    $queue = new ScoliaQueueService($database, $repository, $processor);

    $types = ['THROW_DETECTED', 'TAKEOUT_FINISHED', 'HELLO_CLIENT', 'SBC_STATUS_CHANGED'];
    for ($board = 1; $board <= 10; $board++) {
        for ($sequence = 1; $sequence <= 100; $sequence++) {
            $type = $types[(($sequence - 1) + ($board - 1)) % count($types)];
            $providerId = sprintf('vq-%s-b%02d-e%03d', $suffix, $board, $sequence);
            $message = [
                'id' => $providerId,
                'type' => $type,
                'payload' => [
                    'virtual' => true,
                    'board' => $board,
                    'sequence' => $sequence,
                    'sector' => 'T20',
                    'falseTakeout' => false,
                ],
            ];
            $result = $repository->enqueueEvent($serials[$board], $message);
            $assert($result['duplicate'] === false, 'Unique virtual event was incorrectly deduplicated.');
            $eventIds[$board][$sequence] = (int) $result['id'];

            if ($sequence === 50) {
                $duplicate = $repository->enqueueEvent($serials[$board], $message);
                $assert($duplicate['duplicate'] === true, 'Provider-event dedupe failed for board ' . $board . '.');
                $assert((int) $duplicate['id'] === (int) $result['id'], 'Duplicate event did not resolve to original row.');
                $duplicateCount++;
            }
        }
    }

    $kioskSql = implode(',', array_map('intval', array_values($kioskIds)));
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s)', $p, $kioskSql)) === 1000, 'Expected exactly 1000 unique queued events.');
    $assert($duplicateCount === 10, 'Expected exactly 10 duplicate enqueue attempts.');

    $expectedPriorities = [
        'THROW_DETECTED' => 100,
        'TAKEOUT_FINISHED' => 95,
        'HELLO_CLIENT' => 70,
        'SBC_STATUS_CHANGED' => 40,
    ];
    foreach ($expectedPriorities as $type => $priority) {
        $stmt = $db->prepare(sprintf(
            'SELECT COUNT(*) c,MIN(priority) min_p,MAX(priority) max_p FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND event_type=?',
            $p,
            $kioskSql
        ));
        $stmt->bind_param('s', $type);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        $assert((int) ($row['c'] ?? 0) === 250, 'Unexpected event-type distribution for ' . $type . '.');
        $assert((int) ($row['min_p'] ?? -1) === $priority && (int) ($row['max_p'] ?? -1) === $priority, 'Ingress priority was not assigned for ' . $type . '.');
    }

    // Verify that the first constrained claim chooses the highest-priority eligible
    // board head. Board 1 / event 1 is the earliest priority-100 head.
    $firstExpectedId = $eventIds[1][1];
    $first = $queue->drain(1);
    $assert($first['claimed'] === 1 && $first['processed'] === 1 && $first['failed'] === 0, 'First priority claim did not process exactly one event.');
    $stmt = $db->prepare(sprintf('SELECT processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $firstExpectedId);
    $stmt->execute();
    $firstStatus = (string) ($stmt->get_result()->fetch_assoc()['processing_status'] ?? 'missing');
    $stmt->close();
    $assert($firstStatus === 'ignored', 'Highest-priority eligible board head was not claimed first.');

    // Poison one future board-1 event by pointing its club_id at another valid TEST
    // club. The kiosk remains valid, so processing fails deterministically without
    // malformed SQL or production data. FIFO must then pause only board 1.
    $poisonEventId = $eventIds[1][20];
    $stmt = $db->prepare(sprintf('UPDATE `%1$sscolia_events` SET club_id=? WHERE id=?', $p));
    $stmt->bind_param('ii', $poisonClubId, $poisonEventId);
    $stmt->execute();
    $stmt->close();

    // Simulate a worker dying after claiming a board-2 event. The queue service must
    // recover a stale processing lease and later process the row in FIFO order.
    $staleEventId = $eventIds[2][15];
    $stmt = $db->prepare(sprintf(
        'UPDATE `%1$sscolia_events` SET processing_status="processing",processing_started_at=DATE_SUB(NOW(3),INTERVAL 61 SECOND) WHERE id=?',
        $p
    ));
    $stmt->bind_param('i', $staleEventId);
    $stmt->execute();
    $stmt->close();

    $poisonFrozen = false;
    for ($round = 1; $round <= 180; $round++) {
        $result = $queue->drain(100);

        $stmt = $db->prepare(sprintf('SELECT processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
        $stmt->bind_param('i', $poisonEventId);
        $stmt->execute();
        $poisonStatus = (string) ($stmt->get_result()->fetch_assoc()['processing_status'] ?? 'missing');
        $stmt->close();
        if (!$poisonFrozen && $poisonStatus === 'failed') {
            $stmt = $db->prepare(sprintf('UPDATE `%1$sscolia_events` SET next_attempt_at=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE id=?', $p));
            $stmt->bind_param('i', $poisonEventId);
            $stmt->execute();
            $stmt->close();
            $poisonFrozen = true;
        }

        if ($result['claimed'] === 0) break;
    }
    $assert($poisonFrozen, 'Poison event never reached failed state.');

    for ($board = 2; $board <= 10; $board++) {
        $count = $scalar($db, sprintf(
            'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="ignored"',
            $p,
            $kioskIds[$board]
        ));
        $assert($count === 100, 'Poison event on board 1 blocked virtual board ' . $board . '.');
    }
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="ignored"', $p, $kioskIds[1])) === 19, 'Board 1 should stop immediately before poison event.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="failed"', $p, $kioskIds[1])) === 1, 'Board 1 poison event was not retained as failed.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="queued"', $p, $kioskIds[1])) === 80, 'Board 1 FIFO did not retain all events after poison event.');

    // Recover the poison row and verify the paused board catches up completely.
    $stmt = $db->prepare(sprintf(
        'UPDATE `%1$sscolia_events` SET club_id=?,processing_status="failed",next_attempt_at=NOW(3) WHERE id=?',
        $p
    ));
    $stmt->bind_param('ii', $clubId, $poisonEventId);
    $stmt->execute();
    $stmt->close();

    for ($round = 1; $round <= 120; $round++) {
        $result = $queue->drain(100);
        if ($result['claimed'] === 0) break;
    }

    $processed = $scalar($db, sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND processing_status="ignored"',
        $p,
        $kioskSql
    ));
    $assert($processed === 1000, 'Not all 1000 unique virtual events were drained after recovery.');
    $assert($scalar($db, sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND processing_status IN ("queued","failed","processing","dead_letter")',
        $p,
        $kioskSql
    )) === 0, 'Queue was not empty after recovery.');

    $stmt = $db->prepare(sprintf('SELECT attempt_count,processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $poisonEventId);
    $stmt->execute();
    $poisonFinal = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((string) ($poisonFinal['processing_status'] ?? '') === 'ignored', 'Recovered poison event did not complete.');
    $assert((int) ($poisonFinal['attempt_count'] ?? 0) === 2, 'Recovered poison event should have exactly two processing attempts.');

    $stmt = $db->prepare(sprintf('SELECT attempt_count,processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $staleEventId);
    $stmt->execute();
    $staleFinal = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((string) ($staleFinal['processing_status'] ?? '') === 'ignored', 'Stale processing lease was not recovered.');
    $assert((int) ($staleFinal['attempt_count'] ?? 0) === 1, 'Recovered stale lease should have exactly one real processing attempt.');

    $fifoViolations = $scalar($db, sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` earlier
         INNER JOIN `%1$sscolia_events` later ON later.kiosk_id=earlier.kiosk_id AND later.id>earlier.id
         WHERE earlier.kiosk_id IN (%2$s)
           AND earlier.processed_at IS NOT NULL AND later.processed_at IS NOT NULL
           AND earlier.processed_at>later.processed_at',
        $p,
        $kioskSql
    ));
    $assert($fifoViolations === 0, 'Detected per-board FIFO processing violation.');

    // Bulk command polling must deliver exactly one head per board and preserve
    // command priority/FIFO across all ten virtual boards.
    for ($board = 1; $board <= 10; $board++) {
        $repository->queueCommand($clubId, $kioskIds[$board], 'DELETE_THROW', ['virtual' => true, 'sequence' => 1], null);
        $repository->queueCommand($clubId, $kioskIds[$board], 'RESET_PHASE', ['virtual' => true, 'sequence' => 2], null);
        $repository->queueCommand($clubId, $kioskIds[$board], 'VIRTUAL_PING', ['virtual' => true, 'sequence' => 3], null);
    }

    $expectedCommandBatches = [
        ['DELETE_THROW', 100],
        ['RESET_PHASE', 90],
        ['VIRTUAL_PING', 50],
    ];
    foreach ($expectedCommandBatches as [$expectedType, $expectedPriority]) {
        $commands = $queue->pollCommands(array_values($kioskIds), 100);
        $assert(count($commands) === 10, 'Bulk command poll should return exactly one command per virtual board.');
        $seenBoards = [];
        foreach ($commands as $command) {
            $assert((string) $command['command_type'] === $expectedType, 'Command FIFO/type order mismatch.');
            $assert((int) $command['priority'] === $expectedPriority, 'Command priority mismatch for ' . $expectedType . '.');
            $kioskId = (int) $command['kiosk_id'];
            $assert(!isset($seenBoards[$kioskId]), 'Bulk command poll returned more than one command for a board.');
            $seenBoards[$kioskId] = true;
            $repository->completeCommand((int) $command['id'], 'acked');
        }
    }
    $assert($queue->pollCommands(array_values($kioskIds), 100) === [], 'Command queue did not drain completely.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE kiosk_id IN (%2$s) AND status="acked"', $p, $kioskSql)) === 30, 'Expected 30 acknowledged virtual commands.');

    $elapsedMs = (int) round((microtime(true) - $startedAt) * 1000);
    printf(
        "SCOLIA QUEUE VIRTUAL TEST OK boards=10 events=1000 duplicates=10 commands=30 lost=0 fifo_violations=0 poison_isolation=ok stale_recovery=ok elapsed_ms=%d\n",
        $elapsedMs
    );
} finally {
    if ($kioskIds !== []) {
        $idsSql = implode(',', array_map('intval', array_values($kioskIds)));
        $db->query(sprintf('DELETE FROM `%1$sscolia_commands` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_visit_buffers` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_board_runtime` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_board_settings` WHERE kiosk_id IN (%2$s)', $p, $idsSql));
        $db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id IN (%2$s)', $p, $idsSql));
    }
    if ($clubId > 0) {
        $db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE club_id=%2$d', $p, $clubId));
        $db->query(sprintf('DELETE FROM `%1$sscolia_club_settings` WHERE club_id=%2$d', $p, $clubId));
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $p, $clubId));
    }
    if ($poisonClubId > 0) {
        $db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE club_id=%2$d', $p, $poisonClubId));
        $db->query(sprintf('DELETE FROM `%1$sscolia_club_settings` WHERE club_id=%2$d', $p, $poisonClubId));
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $p, $poisonClubId));
    }
    if ($lockHeld) {
        $stmt = $db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->bind_param('s', $lockName);
        $stmt->execute();
        $stmt->close();
    }
}
