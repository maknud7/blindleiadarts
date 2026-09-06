<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaQueueService;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') exit(2);

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$p = $database->tablePrefix();
if ($p !== 'bd_test_') throw new RuntimeException('Virtual Scolia queue test is TEST-only and refuses table prefix: ' . $p);

$assert = static function (bool $ok, string $message): void {
    if (!$ok) throw new RuntimeException($message);
};
$scalar = static function (mysqli $db, string $sql): int {
    $row = $db->query($sql)->fetch_row();
    return (int) ($row[0] ?? 0);
};
$q = static function (mysqli $db, string $value): string {
    return "'" . $db->real_escape_string($value) . "'";
};

$suffix = strtolower(substr(bin2hex(random_bytes(8)), 0, 12));
$lockName = $p . 'scolia-queue-virtual-test';
$lockHeld = false;
$clubId = 0;
$poisonClubId = 0;
$kioskIds = [];
$serials = [];
$eventIds = [];
$totalStartedAt = microtime(true);

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
        $kioskIds[$board] = (int) $stmt->insert_id;
        $stmt->close();

        $serial = sprintf('VIRTUAL-%s-%02d', strtoupper($suffix), $board);
        $serials[$board] = $serial;
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$sscolia_board_settings` (kiosk_id,serial_number,mode,auto_fallback_to_manual) VALUES (?, ?,"off",1)',
            $p
        ));
        $stmt->bind_param('is', $kioskIds[$board], $serial);
        $stmt->execute();
        $stmt->close();
    }

    $repository = new ScoliaRepository($database);
    $scoring = new CanonicalScoringService($database);
    $processor = new ScoliaScoringService($repository, $scoring, new Dart501Rules());
    $queue = new ScoliaQueueService($database, $repository, $processor);
    $kioskSql = implode(',', array_map('intval', array_values($kioskIds)));

    // Keep repository ingress/dedupe coverage small and focused. The load portion
    // below bulk-loads the staging table so its timing measures queue mechanics,
    // not thousands of remote repository lookup round-trips.
    $duplicateCount = 0;
    for ($board = 1; $board <= 10; $board++) {
        $message = [
            'id' => sprintf('vq-probe-%s-b%02d', $suffix, $board),
            'type' => 'SBC_STATUS_CHANGED',
            'payload' => ['virtual' => true, 'probe' => true],
        ];
        $first = $repository->enqueueEvent($serials[$board], $message);
        $duplicate = $repository->enqueueEvent($serials[$board], $message);
        $assert($first['duplicate'] === false && $duplicate['duplicate'] === true, 'Repository dedupe probe failed for board ' . $board . '.');
        $assert((int) $first['id'] === (int) $duplicate['id'], 'Duplicate probe did not resolve to original event row.');
        $duplicateCount++;
    }
    $probeLike = 'vq-probe-' . $suffix . '-%';
    $stmt = $db->prepare(sprintf('DELETE FROM `%1$sscolia_events` WHERE provider_event_id LIKE ?', $p));
    $stmt->bind_param('s', $probeLike);
    $stmt->execute();
    $stmt->close();
    $assert($duplicateCount === 10, 'Expected 10 successful repository dedupe probes.');

    $types = ['THROW_DETECTED', 'TAKEOUT_FINISHED', 'HELLO_CLIENT', 'SBC_STATUS_CHANGED'];
    $burstStartedAt = microtime(true);
    $batch = [];
    for ($board = 1; $board <= 10; $board++) {
        for ($sequence = 1; $sequence <= 100; $sequence++) {
            $type = $types[(($sequence - 1) + ($board - 1)) % 4];
            $providerId = sprintf('vq-%s-b%02d-e%03d', $suffix, $board, $sequence);
            $dedupeKey = hash('sha256', 'virtual:' . $providerId);
            $payload = json_encode([
                'id' => $providerId,
                'type' => $type,
                'payload' => ['virtual' => true, 'board' => $board, 'sequence' => $sequence, 'sector' => 'T20', 'falseTakeout' => false],
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            $batch[] = sprintf(
                '(%d,%d,NULL,%s,%s,%s,%s)',
                $clubId,
                $kioskIds[$board],
                $q($db, $providerId),
                $q($db, $dedupeKey),
                $q($db, $type),
                $q($db, (string) $payload)
            );
            if (count($batch) === 100) {
                $db->query(sprintf(
                    'INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s',
                    $p,
                    implode(',', $batch)
                ));
                $batch = [];
            }
        }
    }
    if ($batch !== []) {
        $db->query(sprintf(
            'INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s',
            $p,
            implode(',', $batch)
        ));
    }
    $burstInsertMs = (int) round((microtime(true) - $burstStartedAt) * 1000);
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s)', $p, $kioskSql)) === 1000, 'Expected exactly 1000 unique burst events.');

    $result = $db->query(sprintf(
        'SELECT id,provider_event_id FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) ORDER BY id',
        $p,
        $kioskSql
    ));
    while ($row = $result->fetch_assoc()) {
        if (preg_match('/-b(\d{2})-e(\d{3})$/', (string) $row['provider_event_id'], $m) === 1) {
            $eventIds[(int) $m[1]][(int) $m[2]] = (int) $row['id'];
        }
    }
    $assert(count($eventIds) === 10, 'Could not map all virtual event IDs.');

    foreach ([
        'THROW_DETECTED' => 100,
        'TAKEOUT_FINISHED' => 95,
        'HELLO_CLIENT' => 70,
        'SBC_STATUS_CHANGED' => 40,
    ] as $type => $priority) {
        $stmt = $db->prepare(sprintf(
            'SELECT COUNT(*) c,MIN(priority) min_p,MAX(priority) max_p FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND event_type=?',
            $p,
            $kioskSql
        ));
        $stmt->bind_param('s', $type);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        $assert((int) ($row['c'] ?? 0) === 250, 'Unexpected distribution for ' . $type . '.');
        $assert((int) ($row['min_p'] ?? -1) === $priority && (int) ($row['max_p'] ?? -1) === $priority, 'Priority trigger failed for ' . $type . '.');
    }

    // Board 1 and boards 5/9 all have a priority-100 head; board 1 has the oldest ID.
    $firstExpectedId = $eventIds[1][1];
    $first = $queue->drain(1);
    $assert($first === ['claimed' => 1, 'processed' => 1, 'failed' => 0], 'First priority claim did not process exactly one event.');
    $stmt = $db->prepare(sprintf('SELECT processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $firstExpectedId);
    $stmt->execute();
    $assert((string) ($stmt->get_result()->fetch_assoc()['processing_status'] ?? '') === 'ignored', 'Highest-priority oldest board head was not selected first.');
    $stmt->close();

    // Poison board 1 at sequence 20. It must pause only that board.
    $poisonEventId = $eventIds[1][20];
    $stmt = $db->prepare(sprintf('UPDATE `%1$sscolia_events` SET club_id=? WHERE id=?', $p));
    $stmt->bind_param('ii', $poisonClubId, $poisonEventId);
    $stmt->execute();
    $stmt->close();

    // Simulate a worker crash after claiming board 2 sequence 15.
    $staleEventId = $eventIds[2][15];
    $stmt = $db->prepare(sprintf(
        'UPDATE `%1$sscolia_events` SET processing_status="processing",processing_started_at=DATE_SUB(NOW(3),INTERVAL 61 SECOND) WHERE id=?',
        $p
    ));
    $stmt->bind_param('i', $staleEventId);
    $stmt->execute();
    $stmt->close();

    $drainStartedAt = microtime(true);
    $poisonFrozen = false;
    for ($round = 1; $round <= 180; $round++) {
        $drained = $queue->drain(100);
        $stmt = $db->prepare(sprintf('SELECT processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
        $stmt->bind_param('i', $poisonEventId);
        $stmt->execute();
        $poisonStatus = (string) ($stmt->get_result()->fetch_assoc()['processing_status'] ?? '');
        $stmt->close();
        if (!$poisonFrozen && $poisonStatus === 'failed') {
            $stmt = $db->prepare(sprintf('UPDATE `%1$sscolia_events` SET next_attempt_at=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE id=?', $p));
            $stmt->bind_param('i', $poisonEventId);
            $stmt->execute();
            $stmt->close();
            $poisonFrozen = true;
        }
        if ($drained['claimed'] === 0) break;
    }
    $assert($poisonFrozen, 'Poison event never entered failed state.');

    for ($board = 2; $board <= 10; $board++) {
        $count = $scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="ignored"', $p, $kioskIds[$board]));
        $assert($count === 100, 'Poison event on board 1 blocked board ' . $board . '.');
    }
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="ignored"', $p, $kioskIds[1])) === 19, 'Board 1 did not stop directly before poison event.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="failed"', $p, $kioskIds[1])) === 1, 'Poison event was not retained as failed.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id=%2$d AND processing_status="queued"', $p, $kioskIds[1])) === 80, 'Board 1 FIFO did not retain later events.');

    // Repair the poison row and drain the paused board.
    $stmt = $db->prepare(sprintf('UPDATE `%1$sscolia_events` SET club_id=?,processing_status="failed",next_attempt_at=NOW(3) WHERE id=?', $p));
    $stmt->bind_param('ii', $clubId, $poisonEventId);
    $stmt->execute();
    $stmt->close();
    for ($round = 1; $round <= 120; $round++) {
        $drained = $queue->drain(100);
        if ($drained['claimed'] === 0) break;
    }
    $drainMs = (int) round((microtime(true) - $drainStartedAt) * 1000);

    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND processing_status="ignored"', $p, $kioskSql)) === 1000, 'Not all 1000 events completed after recovery.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s) AND processing_status IN ("queued","failed","processing","dead_letter")', $p, $kioskSql)) === 0, 'Queue was not empty after recovery.');

    $stmt = $db->prepare(sprintf('SELECT attempt_count,processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $poisonEventId);
    $stmt->execute();
    $poisonFinal = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((string) ($poisonFinal['processing_status'] ?? '') === 'ignored' && (int) ($poisonFinal['attempt_count'] ?? 0) === 2, 'Poison recovery did not complete in exactly two attempts.');

    $stmt = $db->prepare(sprintf('SELECT attempt_count,processing_status FROM `%1$sscolia_events` WHERE id=?', $p));
    $stmt->bind_param('i', $staleEventId);
    $stmt->execute();
    $staleFinal = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((string) ($staleFinal['processing_status'] ?? '') === 'ignored' && (int) ($staleFinal['attempt_count'] ?? 0) === 1, 'Stale processing lease did not recover cleanly.');

    $fifoViolations = $scalar($db, sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` earlier
         INNER JOIN `%1$sscolia_events` later ON later.kiosk_id=earlier.kiosk_id AND later.id>earlier.id
         WHERE earlier.kiosk_id IN (%2$s)
           AND earlier.processed_at IS NOT NULL AND later.processed_at IS NOT NULL
           AND earlier.processed_at>later.processed_at',
        $p,
        $kioskSql
    ));
    $assert($fifoViolations === 0, 'Detected per-board FIFO violation.');

    // Three command heads per board; bulk polling must return one per board per pass.
    for ($board = 1; $board <= 10; $board++) {
        $repository->queueCommand($clubId, $kioskIds[$board], 'DELETE_THROW', ['virtual' => true, 'sequence' => 1], null);
        $repository->queueCommand($clubId, $kioskIds[$board], 'RESET_PHASE', ['virtual' => true, 'sequence' => 2], null);
        $repository->queueCommand($clubId, $kioskIds[$board], 'VIRTUAL_PING', ['virtual' => true, 'sequence' => 3], null);
    }
    foreach ([['DELETE_THROW', 100], ['RESET_PHASE', 90], ['VIRTUAL_PING', 50]] as [$expectedType, $expectedPriority]) {
        $commands = $queue->pollCommands(array_values($kioskIds), 100);
        $assert(count($commands) === 10, 'Bulk command poll did not return exactly one head per board.');
        $seen = [];
        foreach ($commands as $command) {
            $assert((string) $command['command_type'] === $expectedType, 'Command FIFO/type mismatch.');
            $assert((int) $command['priority'] === $expectedPriority, 'Command priority mismatch for ' . $expectedType . '.');
            $kid = (int) $command['kiosk_id'];
            $assert(!isset($seen[$kid]), 'Bulk command poll returned two commands for one board.');
            $seen[$kid] = true;
            $repository->completeCommand((int) $command['id'], 'acked');
        }
    }
    $assert($queue->pollCommands(array_values($kioskIds), 100) === [], 'Command queue did not drain completely.');
    $assert($scalar($db, sprintf('SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE kiosk_id IN (%2$s) AND status="acked"', $p, $kioskSql)) === 30, 'Expected 30 acknowledged virtual commands.');

    $totalMs = (int) round((microtime(true) - $totalStartedAt) * 1000);
    $throughput = $drainMs > 0 ? round(1000000 / $drainMs, 1) : 0.0;
    printf(
        "SCOLIA QUEUE VIRTUAL TEST OK boards=10 events=1000 dedupe_probes=10 commands=30 lost=0 fifo_violations=0 poison_isolation=ok stale_recovery=ok burst_insert_ms=%d drain_ms=%d drain_events_per_sec=%.1f total_ms=%d\n",
        $burstInsertMs,
        $drainMs,
        $throughput,
        $totalMs
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
