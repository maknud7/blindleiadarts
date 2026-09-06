<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\MatchScoringRepository;
use Blindleia\Dartkiosk\Api\Repository\PlayerBreakRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentOperationsRepository;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaQueueService;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') {
    exit(2);
}

const MIX_SLOW_OPERATION_MS = 750.0;
const MIX_MAX_OPERATION_MS = 2000.0;
const MIX_WORKER_TIMEOUT_SECONDS = 75;

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function mixArg(string $name): ?string
{
    global $argv;
    $prefix = '--' . $name . '=';
    foreach ($argv as $arg) {
        if (str_starts_with($arg, $prefix)) {
            return substr($arg, strlen($prefix));
        }
    }
    return null;
}

/** @return array<string,mixed> */
function mixLoadFixture(string $path): array
{
    $json = file_get_contents($path);
    if ($json === false) {
        throw new RuntimeException('Could not read mixed-load fixture file.');
    }
    $fixture = json_decode($json, true);
    if (!is_array($fixture)) {
        throw new RuntimeException('Mixed-load fixture is invalid JSON.');
    }
    return $fixture;
}

/** @return array{database:Database,db:mysqli,prefix:string} */
function mixDatabase(string $root): array
{
    $config = Config::load($root . '/apps/api');
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    if ($prefix !== 'bd_test_') {
        throw new RuntimeException('Mixed load test is TEST-only and refuses table prefix: ' . $prefix);
    }
    $db->query('SET SESSION innodb_lock_wait_timeout=2');
    return ['database' => $database, 'db' => $db, 'prefix' => $prefix];
}

/**
 * @param array<string,mixed> $metrics
 * @return mixed
 */
function mixTimed(array &$metrics, string $operation, callable $callback): mixed
{
    $started = microtime(true);
    try {
        return $callback();
    } catch (mysqli_sql_exception $error) {
        $code = (int) $error->getCode();
        if (in_array($code, [1205, 1213], true)) {
            throw new RuntimeException(sprintf(
                'DB locking failure in %s: mysql=%d %s',
                $operation,
                $code,
                $error->getMessage()
            ), $code, $error);
        }
        throw $error;
    } finally {
        $elapsedMs = (microtime(true) - $started) * 1000;
        $metrics['ops'] = (int) ($metrics['ops'] ?? 0) + 1;
        $metrics['max_ms'] = max((float) ($metrics['max_ms'] ?? 0.0), $elapsedMs);
        if ($elapsedMs >= MIX_SLOW_OPERATION_MS) {
            $metrics['slow_ops'] = (int) ($metrics['slow_ops'] ?? 0) + 1;
            $metrics['slowest'][] = ['operation' => $operation, 'ms' => round($elapsedMs, 1)];
            usort($metrics['slowest'], static fn(array $a, array $b): int => $b['ms'] <=> $a['ms']);
            $metrics['slowest'] = array_slice($metrics['slowest'], 0, 5);
        }
        if ($elapsedMs > MIX_MAX_OPERATION_MS && !isset($metrics['hard_slow'])) {
            $metrics['hard_slow'] = ['operation' => $operation, 'ms' => round($elapsedMs, 1)];
        }
    }
}

function mixWaitForStart(array $fixture): void
{
    $startFile = (string) ($fixture['start_file'] ?? '');
    if ($startFile === '') {
        throw new RuntimeException('Worker start barrier is missing.');
    }
    $deadline = microtime(true) + 15;
    while (!is_file($startFile)) {
        if (microtime(true) >= $deadline) {
            throw new RuntimeException('Worker start barrier timed out.');
        }
        usleep(10000);
    }
}

/** @return array<string,mixed> */
function mixWorker(string $root, string $worker, int $workerId, array $fixture): array
{
    mixWaitForStart($fixture);
    $ctx = mixDatabase($root);
    /** @var Database $database */
    $database = $ctx['database'];
    /** @var mysqli $db */
    $db = $ctx['db'];
    $prefix = $ctx['prefix'];
    $metrics = [
        'worker' => $worker,
        'worker_id' => $workerId,
        'ops' => 0,
        'max_ms' => 0.0,
        'slow_ops' => 0,
        'slowest' => [],
    ];

    $clubId = (int) $fixture['club_id'];
    $tournamentId = (int) $fixture['tournament_id'];
    $kioskIds = array_map('intval', $fixture['kiosk_ids']);

    if ($worker === 'queue') {
        $repository = new ScoliaRepository($database);
        $canonical = new CanonicalScoringService($database);
        $processor = new ScoliaScoringService($repository, $canonical, new Dart501Rules());
        $queue = new ScoliaQueueService($database, $repository, $processor);
        for ($round = 0; $round < 400; $round++) {
            $drained = mixTimed($metrics, 'scolia.queue.drain', static fn() => $queue->drain(20, $kioskIds));
            if ((int) ($drained['claimed'] ?? 0) === 0) {
                break;
            }
            usleep(random_int(1000, 7000));
        }
    } elseif ($worker === 'commands') {
        $repository = new ScoliaRepository($database);
        $canonical = new CanonicalScoringService($database);
        $processor = new ScoliaScoringService($repository, $canonical, new Dart501Rules());
        $queue = new ScoliaQueueService($database, $repository, $processor);
        for ($round = 0; $round < 300; $round++) {
            $commands = mixTimed($metrics, 'scolia.commands.poll', static fn() => $queue->pollCommands($kioskIds, 40));
            foreach ($commands as $command) {
                mixTimed(
                    $metrics,
                    'scolia.commands.ack',
                    static fn() => $repository->completeCommand((int) $command['id'], 'acked')
                );
            }
            if ($commands === []) {
                break;
            }
            usleep(random_int(1000, 5000));
        }
    } elseif ($worker === 'manual-score') {
        $manualIds = array_map('intval', $fixture['manual_kiosk_ids']);
        $kioskId = $manualIds[$workerId % count($manualIds)];
        $scoring = new MatchScoringRepository($database);
        mixTimed($metrics, 'match.start', static fn() => $scoring->startMatch($kioskId));
        for ($visit = 1; $visit <= 40; $visit++) {
            $requestId = sprintf('mix-%s-manual-%d-%d', $fixture['suffix'], $workerId, $visit);
            mixTimed($metrics, 'match.record_visit', static fn() => $scoring->recordVisit($kioskId, [
                'input_mode' => 'sum',
                'score' => 20,
                'darts_used' => 3,
                'request_id' => $requestId,
            ]));
            if ($visit % 10 === 0) {
                mixTimed($metrics, 'match.undo', static fn() => $scoring->undoLastVisit($kioskId));
                $requestId .= '-redo';
                mixTimed($metrics, 'match.record_visit.redo', static fn() => $scoring->recordVisit($kioskId, [
                    'input_mode' => 'sum',
                    'score' => 20,
                    'darts_used' => 3,
                    'request_id' => $requestId,
                ]));
            }
            usleep(random_int(1000, 9000));
        }
    } elseif ($worker === 'breaks') {
        $breaks = new PlayerBreakRepository($database);
        $players = array_map('intval', $fixture['break_player_ids']);
        for ($round = 1; $round <= 12; $round++) {
            foreach ($players as $playerId) {
                mixTimed($metrics, 'player_break.request', static fn() => $breaks->requestBreak($tournamentId, $playerId));
                mixTimed($metrics, 'player_break.expire_sql', static function () use ($db, $prefix, $tournamentId, $playerId): void {
                    $stmt = $db->prepare(sprintf(
                        'UPDATE `%1$stournament_player_breaks` SET ends_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE tournament_id=? AND player_id=? AND status="active"',
                        $prefix
                    ));
                    $stmt->bind_param('ii', $tournamentId, $playerId);
                    $stmt->execute();
                    $stmt->close();
                });
                mixTimed($metrics, 'player_break.normalize', static fn() => $breaks->normalizeTournament($tournamentId));
            }
            usleep(random_int(2000, 10000));
        }
    } elseif ($worker === 'operations') {
        $operations = new TournamentOperationsRepository($database);
        for ($round = 1; $round <= 90; $round++) {
            mixTimed($metrics, 'tournament.snapshot', static fn() => $operations->snapshot($tournamentId));
            if ($round % 3 === 0) {
                mixTimed($metrics, 'tournament.reconcile', static fn() => $operations->reconcileTournament($tournamentId));
            }
            $kioskId = $kioskIds[$round % count($kioskIds)];
            if ($round % 5 === 0) {
                mixTimed($metrics, 'tournament.kiosk_post_match', static fn() => $operations->kioskPostMatch($kioskId));
            }
            usleep(random_int(1000, 8000));
        }
    } elseif ($worker === 'admin') {
        $operations = new TournamentOperationsRepository($database);
        for ($round = 1; $round <= 80; $round++) {
            $enabled = ($round % 2) === 0;
            mixTimed($metrics, 'admin.auto_assign_toggle', static fn() => $operations->updateAutoAssignEnabled($tournamentId, $enabled));
            usleep(random_int(1000, 8000));
        }
        mixTimed($metrics, 'admin.auto_assign_restore', static fn() => $operations->updateAutoAssignEnabled($tournamentId, true));
    } elseif ($worker === 'reader') {
        for ($round = 1; $round <= 220; $round++) {
            mixTimed($metrics, 'live.match_read', static function () use ($db, $prefix, $tournamentId): void {
                $stmt = $db->prepare(sprintf(
                    'SELECT m.id,m.status,m.kiosk_id,m.player_a_id,m.player_b_id,COUNT(v.id) AS visits
                     FROM `%1$smatches` m
                     LEFT JOIN `%1$svisits` v ON v.match_id=m.id
                     WHERE m.tournament_id=?
                     GROUP BY m.id,m.status,m.kiosk_id,m.player_a_id,m.player_b_id
                     ORDER BY m.id',
                    $prefix
                ));
                $stmt->bind_param('i', $tournamentId);
                $stmt->execute();
                $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                $stmt->close();
            });
            if ($round % 2 === 0) {
                mixTimed($metrics, 'live.queue_read', static function () use ($db, $prefix, $clubId): void {
                    $stmt = $db->prepare(sprintf(
                        'SELECT processing_status,COUNT(*) AS c FROM `%1$sscolia_events` WHERE club_id=? GROUP BY processing_status',
                        $prefix
                    ));
                    $stmt->bind_param('i', $clubId);
                    $stmt->execute();
                    $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                    $stmt->close();
                });
            }
            if ($round % 3 === 0) {
                mixTimed($metrics, 'live.player_read', static function () use ($db, $prefix, $tournamentId): void {
                    $stmt = $db->prepare(sprintf(
                        'SELECT status,COUNT(*) AS c FROM `%1$stournament_players` WHERE tournament_id=? GROUP BY status',
                        $prefix
                    ));
                    $stmt->bind_param('i', $tournamentId);
                    $stmt->execute();
                    $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                    $stmt->close();
                });
            }
            usleep(random_int(500, 5000));
        }
    } elseif ($worker === 'runtime') {
        $repository = new ScoliaRepository($database);
        for ($round = 1; $round <= 30; $round++) {
            foreach ($kioskIds as $kioskId) {
                mixTimed($metrics, 'scolia.runtime.heartbeat', static fn() => $repository->bridgeHeartbeat($kioskId, 'connected'));
                mixTimed($metrics, 'scolia.runtime.status', static fn() => $repository->updateRuntimeStatus($kioskId, [
                    'boardStatus' => 'READY',
                    'boardPhase' => ($round % 2 === 0) ? 'Throw' : 'Takeout',
                ]));
            }
            usleep(random_int(1000, 7000));
        }
    } else {
        throw new RuntimeException('Unknown mixed-load worker: ' . $worker);
    }

    if (isset($metrics['hard_slow'])) {
        $slow = $metrics['hard_slow'];
        throw new RuntimeException(sprintf(
            'Operation exceeded %.0fms hard limit: %s %.1fms',
            MIX_MAX_OPERATION_MS,
            $slow['operation'],
            $slow['ms']
        ));
    }

    $metrics['max_ms'] = round((float) $metrics['max_ms'], 1);
    return $metrics;
}

$worker = mixArg('worker');
if ($worker !== null) {
    $fixturePath = mixArg('fixture');
    $workerId = (int) (mixArg('id') ?? '0');
    if ($fixturePath === null) {
        fwrite(STDERR, "Missing --fixture for mixed-load worker.\n");
        exit(2);
    }
    try {
        $result = mixWorker($root, $worker, $workerId, mixLoadFixture($fixturePath));
        echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
        exit(0);
    } catch (Throwable $error) {
        fwrite(STDERR, sprintf("%s worker %d failed: %s\n", $worker, $workerId, $error->getMessage()));
        exit(1);
    }
}

$ctx = mixDatabase($root);
/** @var Database $database */
$database = $ctx['database'];
/** @var mysqli $db */
$db = $ctx['db'];
$prefix = $ctx['prefix'];

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};
$scalar = static function (string $sql) use ($db): int {
    $row = $db->query($sql)->fetch_row();
    return (int) ($row[0] ?? 0);
};
$q = static function (string $value) use ($db): string {
    return "'" . $db->real_escape_string($value) . "'";
};

$suffix = strtolower(substr(bin2hex(random_bytes(8)), 0, 12));
$lockName = $prefix . 'scolia-mixed-load-test';
$lockHeld = false;
$ids = [
    'club' => 0,
    'season' => 0,
    'tournament' => 0,
    'kiosks' => [],
    'players' => [],
    'matches' => [],
];
$fixturePath = sys_get_temp_dir() . '/blindleia-mixed-' . $suffix . '.json';
$startFile = sys_get_temp_dir() . '/blindleia-mixed-start-' . $suffix;
$processes = [];
$testStarted = microtime(true);

$stmt = $db->prepare('SELECT GET_LOCK(?, 120) AS locked');
$stmt->bind_param('s', $lockName);
$stmt->execute();
$lockHeld = (int) ($stmt->get_result()->fetch_assoc()['locked'] ?? 0) === 1;
$stmt->close();
$assert($lockHeld, 'Could not acquire isolated mixed-load test lock.');

try {
    $clubName = 'Mixed Load ' . $suffix;
    $clubSlug = 'mixed-load-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $seasonName = 'Mixed Load Season ' . $suffix;
    $starts = date('Y-m-d');
    $ends = date('Y-m-d', strtotime('+1 month'));
    $active = 1;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sseasons` (club_id,name,starts_on,ends_on,is_active) VALUES (?,?,?,?,?)', $prefix));
    $stmt->bind_param('isssi', $ids['club'], $seasonName, $starts, $ends, $active);
    $stmt->execute();
    $ids['season'] = (int) $stmt->insert_id;
    $stmt->close();

    $tournamentName = 'Mixed Tournament ' . $suffix;
    $tournamentSlug = 'mixed-tournament-' . $suffix;
    $status = 'in_progress';
    $startAt = date('Y-m-d H:i:s');
    $autoAssign = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$stournaments` (club_id,season_id,name,slug,provider_system,status,start_at,auto_assign_enabled)
         VALUES (?,?,?,? ,"local",?,?,?)',
        $prefix
    ));
    $stmt->bind_param('iissssi', $ids['club'], $ids['season'], $tournamentName, $tournamentSlug, $status, $startAt, $autoAssign);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    $playerSql = sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)', $prefix);
    $registrationSql = sprintf(
        'INSERT INTO `%1$stournament_players` (tournament_id,player_id,status,registration_source) VALUES (?,? ,"checked_in","mixed_load")',
        $prefix
    );
    for ($player = 1; $player <= 24; $player++) {
        $name = sprintf('Mixed Player %02d %s', $player, $suffix);
        $stmt = $db->prepare($playerSql);
        $stmt->bind_param('is', $ids['club'], $name);
        $stmt->execute();
        $playerId = (int) $stmt->insert_id;
        $stmt->close();
        $ids['players'][] = $playerId;

        $stmt = $db->prepare($registrationSql);
        $stmt->bind_param('ii', $ids['tournament'], $playerId);
        $stmt->execute();
        $stmt->close();
    }

    $boardSql = sprintf(
        'INSERT INTO `%1$skiosks` (club_id,code,name,board_number,is_active,scoring_mode) VALUES (?,?,?,?,1,?)',
        $prefix
    );
    $linkSql = sprintf('INSERT INTO `%1$stournament_kiosks` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)', $prefix);
    for ($board = 1; $board <= 10; $board++) {
        $code = sprintf('MIX-%s-%02d', strtoupper(substr($suffix, 0, 6)), $board);
        $name = 'Mixed Board ' . $board;
        $boardNumber = 9700 + $board;
        $scoringMode = $board <= 6 ? 'scolia' : 'manual';
        $stmt = $db->prepare($boardSql);
        $stmt->bind_param('issis', $ids['club'], $code, $name, $boardNumber, $scoringMode);
        $stmt->execute();
        $kioskId = (int) $stmt->insert_id;
        $stmt->close();
        $ids['kiosks'][$board] = $kioskId;

        $stmt = $db->prepare($linkSql);
        $stmt->bind_param('iii', $ids['tournament'], $kioskId, $board);
        $stmt->execute();
        $stmt->close();

        $serial = sprintf('MIXED-%s-%02d', strtoupper($suffix), $board);
        $mode = $board <= 6 ? 'live' : 'off';
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$sscolia_board_settings` (kiosk_id,serial_number,mode,auto_fallback_to_manual) VALUES (?,?,?,1)',
            $prefix
        ));
        $stmt->bind_param('iss', $kioskId, $serial, $mode);
        $stmt->execute();
        $stmt->close();
    }

    $token = 'mixed-load-test';
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$sscolia_club_settings` (club_id,enabled,access_token,queue_max_attempts,queue_retry_base_seconds) VALUES (?,0,?,8,1)',
        $prefix
    ));
    $stmt->bind_param('is', $ids['club'], $token);
    $stmt->execute();
    $stmt->close();

    $matchSql = sprintf(
        'INSERT INTO `%1$smatches`
         (tournament_id,kiosk_id,round_label,round_number,status,best_of_legs,legs_to_win,player_a_id,player_b_id)
         VALUES (?,?,"Mixed",1,"assigned",9,5,?,?)',
        $prefix
    );
    for ($board = 1; $board <= 10; $board++) {
        $playerA = $ids['players'][($board - 1) * 2];
        $playerB = $ids['players'][($board - 1) * 2 + 1];
        $stmt = $db->prepare($matchSql);
        $stmt->bind_param('iiii', $ids['tournament'], $ids['kiosks'][$board], $playerA, $playerB);
        $stmt->execute();
        $ids['matches'][$board] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $eventRows = [];
    $expectedEvents = 0;
    for ($board = 1; $board <= 10; $board++) {
        $kioskId = $ids['kiosks'][$board];
        $matchId = $ids['matches'][$board];
        if ($board <= 6) {
            for ($cycle = 1; $cycle <= 15; $cycle++) {
                foreach ([1, 2, 3] as $dart) {
                    $providerId = sprintf('mix-%s-b%02d-c%02d-d%d', $suffix, $board, $cycle, $dart);
                    $dedupe = hash('sha256', 'mixed:' . $providerId);
                    $payload = json_encode([
                        'id' => $providerId,
                        'type' => 'THROW_DETECTED',
                        'payload' => ['sector' => 'S20', 'bounceout' => false],
                    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    $eventRows[] = sprintf(
                        '(%d,%d,%d,%s,%s,"THROW_DETECTED",%s)',
                        $ids['club'], $kioskId, $matchId, $q($providerId), $q($dedupe), $q((string) $payload)
                    );
                    $expectedEvents++;
                }
                $providerId = sprintf('mix-%s-b%02d-c%02d-takeout', $suffix, $board, $cycle);
                $dedupe = hash('sha256', 'mixed:' . $providerId);
                $payload = json_encode([
                    'id' => $providerId,
                    'type' => 'TAKEOUT_FINISHED',
                    'payload' => ['falseTakeout' => false],
                ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                $eventRows[] = sprintf(
                    '(%d,%d,%d,%s,%s,"TAKEOUT_FINISHED",%s)',
                    $ids['club'], $kioskId, $matchId, $q($providerId), $q($dedupe), $q((string) $payload)
                );
                $expectedEvents++;
            }
            for ($statusSeq = 1; $statusSeq <= 20; $statusSeq++) {
                $providerId = sprintf('mix-%s-b%02d-status-%02d', $suffix, $board, $statusSeq);
                $dedupe = hash('sha256', 'mixed:' . $providerId);
                $payload = json_encode([
                    'id' => $providerId,
                    'type' => 'SBC_STATUS_CHANGED',
                    'payload' => ['boardStatus' => 'READY', 'boardPhase' => 'Throw'],
                ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                $eventRows[] = sprintf(
                    '(%d,%d,%d,%s,%s,"SBC_STATUS_CHANGED",%s)',
                    $ids['club'], $kioskId, $matchId, $q($providerId), $q($dedupe), $q((string) $payload)
                );
                $expectedEvents++;
            }
        } else {
            for ($statusSeq = 1; $statusSeq <= 60; $statusSeq++) {
                $providerId = sprintf('mix-%s-b%02d-off-%02d', $suffix, $board, $statusSeq);
                $dedupe = hash('sha256', 'mixed:' . $providerId);
                $payload = json_encode([
                    'id' => $providerId,
                    'type' => 'SBC_STATUS_CHANGED',
                    'payload' => ['boardStatus' => 'READY'],
                ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                $eventRows[] = sprintf(
                    '(%d,%d,%d,%s,%s,"SBC_STATUS_CHANGED",%s)',
                    $ids['club'], $kioskId, $matchId, $q($providerId), $q($dedupe), $q((string) $payload)
                );
                $expectedEvents++;
            }
        }
        if (count($eventRows) >= 100) {
            $db->query(sprintf(
                'INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s',
                $prefix,
                implode(',', $eventRows)
            ));
            $eventRows = [];
        }
    }
    if ($eventRows !== []) {
        $db->query(sprintf(
            'INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s',
            $prefix,
            implode(',', $eventRows)
        ));
    }
    $assert($expectedEvents === 720, 'Mixed fixture should contain exactly 720 Scolia events.');

    $commandRows = [];
    $expectedCommands = 0;
    $commandTypes = ['PING', 'START_MATCH', 'UNDO_LAST_VISIT', 'SYNC_STATE'];
    for ($board = 1; $board <= 10; $board++) {
        for ($sequence = 1; $sequence <= 30; $sequence++) {
            $type = $commandTypes[($sequence - 1) % count($commandTypes)];
            $messageId = sprintf('mix-%s-command-b%02d-%03d', $suffix, $board, $sequence);
            $payload = json_encode(['mixed' => true, 'board' => $board, 'sequence' => $sequence]);
            $commandRows[] = sprintf(
                '(%d,%d,%s,%s,%s)',
                $ids['club'], $ids['kiosks'][$board], $q($type), $q($messageId), $q((string) $payload)
            );
            $expectedCommands++;
            if (count($commandRows) === 100) {
                $db->query(sprintf(
                    'INSERT INTO `%1$sscolia_commands` (club_id,kiosk_id,command_type,message_id,payload_json) VALUES %2$s',
                    $prefix,
                    implode(',', $commandRows)
                ));
                $commandRows = [];
            }
        }
    }
    if ($commandRows !== []) {
        $db->query(sprintf(
            'INSERT INTO `%1$sscolia_commands` (club_id,kiosk_id,command_type,message_id,payload_json) VALUES %2$s',
            $prefix,
            implode(',', $commandRows)
        ));
    }
    $assert($expectedCommands === 300, 'Mixed fixture should contain exactly 300 Scolia commands.');

    $fixture = [
        'suffix' => $suffix,
        'start_file' => $startFile,
        'club_id' => $ids['club'],
        'tournament_id' => $ids['tournament'],
        'kiosk_ids' => array_values($ids['kiosks']),
        'scolia_kiosk_ids' => array_values(array_slice($ids['kiosks'], 0, 6, true)),
        'manual_kiosk_ids' => array_values(array_slice($ids['kiosks'], 6, 4, true)),
        'break_player_ids' => array_slice($ids['players'], 20, 4),
        'match_ids' => array_values($ids['matches']),
        'expected_events' => $expectedEvents,
        'expected_commands' => $expectedCommands,
    ];
    file_put_contents($fixturePath, json_encode($fixture, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

    $workerSpecs = [
        ['queue', 0], ['queue', 1], ['queue', 2],
        ['commands', 0], ['commands', 1],
        ['manual-score', 0], ['manual-score', 1], ['manual-score', 2], ['manual-score', 3],
        ['breaks', 0],
        ['operations', 0],
        ['admin', 0],
        ['reader', 0], ['reader', 1],
        ['runtime', 0],
    ];

    foreach ($workerSpecs as [$workerName, $workerId]) {
        $command = sprintf(
            '%s %s --worker=%s --id=%d --fixture=%s',
            escapeshellarg(PHP_BINARY),
            escapeshellarg(__FILE__),
            escapeshellarg($workerName),
            $workerId,
            escapeshellarg($fixturePath)
        );
        $pipes = [];
        $process = proc_open($command, [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ], $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('Could not start worker ' . $workerName . '#' . $workerId);
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $processes[] = [
            'name' => $workerName,
            'id' => $workerId,
            'process' => $process,
            'stdout' => $pipes[1],
            'stderr' => $pipes[2],
            'output' => '',
            'error' => '',
            'exit_code' => null,
        ];
    }

    touch($startFile);
    $deadline = microtime(true) + MIX_WORKER_TIMEOUT_SECONDS;
    $running = true;
    while ($running) {
        $running = false;
        foreach ($processes as &$entry) {
            if ($entry['exit_code'] !== null) {
                continue;
            }
            $entry['output'] .= stream_get_contents($entry['stdout']);
            $entry['error'] .= stream_get_contents($entry['stderr']);
            $statusRow = proc_get_status($entry['process']);
            if ($statusRow['running']) {
                $running = true;
                continue;
            }
            $entry['exit_code'] = (int) $statusRow['exitcode'];
            $entry['output'] .= stream_get_contents($entry['stdout']);
            $entry['error'] .= stream_get_contents($entry['stderr']);
            fclose($entry['stdout']);
            fclose($entry['stderr']);
            proc_close($entry['process']);
        }
        unset($entry);
        if ($running && microtime(true) >= $deadline) {
            foreach ($processes as &$entry) {
                if ($entry['exit_code'] === null) {
                    proc_terminate($entry['process']);
                }
            }
            unset($entry);
            throw new RuntimeException('Mixed-load workers exceeded ' . MIX_WORKER_TIMEOUT_SECONDS . ' seconds.');
        }
        if ($running) {
            usleep(50000);
        }
    }

    $workerResults = [];
    foreach ($processes as $entry) {
        $assert(
            $entry['exit_code'] === 0,
            sprintf(
                '%s worker %d failed (exit %s): %s',
                $entry['name'],
                $entry['id'],
                var_export($entry['exit_code'], true),
                trim((string) $entry['error'])
            )
        );
        $lines = array_values(array_filter(array_map('trim', explode("\n", trim((string) $entry['output'])))));
        $json = $lines === [] ? '' : end($lines);
        $decoded = json_decode((string) $json, true);
        $assert(is_array($decoded), sprintf('Worker %s#%d returned invalid metrics.', $entry['name'], $entry['id']));
        $workerResults[] = $decoded;
    }

    $eventPrefix = $db->real_escape_string('mix-' . $suffix . '-%');
    $eventCount = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s"',
        $prefix,
        $eventPrefix
    ));
    $assert($eventCount === $expectedEvents, 'Scolia event count changed under load.');
    $nonTerminal = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s" AND processing_status IN ("queued","processing","failed","dead_letter")',
        $prefix,
        $eventPrefix
    ));
    $assert($nonTerminal === 0, 'Some Scolia events were left non-terminal after mixed load.');
    $failedEvents = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s" AND processing_status IN ("failed","dead_letter")',
        $prefix,
        $eventPrefix
    ));
    $assert($failedEvents === 0, 'Scolia events failed during mixed load.');
    $retriedEvents = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s" AND attempt_count<>1',
        $prefix,
        $eventPrefix
    ));
    $assert($retriedEvents === 0, 'Scolia event was claimed more than once or not claimed.');
    $fifoViolations = $scalar(sprintf(
        'SELECT COUNT(*)
         FROM `%1$sscolia_events` later
         INNER JOIN `%1$sscolia_events` earlier
           ON earlier.kiosk_id=later.kiosk_id AND earlier.id<later.id
         WHERE later.provider_event_id LIKE "%2$s"
           AND earlier.provider_event_id LIKE "%2$s"
           AND later.processed_at IS NOT NULL
           AND earlier.processed_at IS NOT NULL
           AND later.processed_at<earlier.processed_at',
        $prefix,
        $eventPrefix
    ));
    $assert($fifoViolations === 0, 'Per-board FIFO completion order was violated.');

    $commandPrefix = $db->real_escape_string('mix-' . $suffix . '-command-%');
    $commandCount = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE message_id LIKE "%2$s"',
        $prefix,
        $commandPrefix
    ));
    $assert($commandCount === $expectedCommands, 'Scolia command count changed under load.');
    $ackedCommands = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE message_id LIKE "%2$s" AND status="acked"',
        $prefix,
        $commandPrefix
    ));
    $assert($ackedCommands === $expectedCommands, 'Not all Scolia commands were acknowledged.');
    $retriedCommands = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE message_id LIKE "%2$s" AND attempt_count<>1',
        $prefix,
        $commandPrefix
    ));
    $assert($retriedCommands === 0, 'Scolia command was delivered more than once or not delivered.');

    $manualKioskSql = implode(',', array_map('intval', $fixture['manual_kiosk_ids']));
    $manualVisits = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$svisits` v INNER JOIN `%1$smatches` m ON m.id=v.match_id WHERE m.kiosk_id IN (%2$s)',
        $prefix,
        $manualKioskSql
    ));
    $assert($manualVisits === 160, 'Manual scoring lost or duplicated visits under mixed load.');

    $openBreaks = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d AND status IN ("scheduled","active")',
        $prefix,
        $ids['tournament']
    ));
    $assert($openBreaks === 0, 'Player pause normalization left an active/scheduled break behind.');
    $pausedPlayers = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id IN (%3$s) AND status<>"checked_in"',
        $prefix,
        $ids['tournament'],
        implode(',', array_map('intval', $fixture['break_player_ids']))
    ));
    $assert($pausedPlayers === 0, 'Player pause normalization did not restore checked-in state.');

    $maxWorkerMs = 0.0;
    $slowOps = 0;
    $totalOps = 0;
    $slowest = [];
    foreach ($workerResults as $result) {
        $maxWorkerMs = max($maxWorkerMs, (float) ($result['max_ms'] ?? 0));
        $slowOps += (int) ($result['slow_ops'] ?? 0);
        $totalOps += (int) ($result['ops'] ?? 0);
        foreach (($result['slowest'] ?? []) as $slow) {
            $slowest[] = sprintf('%s#%d %s %.1fms', $result['worker'], $result['worker_id'], $slow['operation'], $slow['ms']);
        }
    }

    $elapsedMs = (int) round((microtime(true) - $testStarted) * 1000);
    echo "Scolia mixed load OK\n";
    echo sprintf("Workers: %d | Operations: %d | Wall: %d ms | Max operation: %.1f ms | Slow >= %.0f ms: %d\n",
        count($workerResults), $totalOps, $elapsedMs, $maxWorkerMs, MIX_SLOW_OPERATION_MS, $slowOps);
    echo sprintf("Scolia events: %d terminal | Commands: %d acked | Manual visits: %d | DB deadlocks/lock timeouts: 0 | FIFO violations: 0\n",
        $eventCount, $ackedCommands, $manualVisits);
    if ($slowest !== []) {
        echo 'Slowest samples: ' . implode(' | ', array_slice($slowest, 0, 8)) . "\n";
    }
} finally {
    if (is_file($startFile)) {
        @unlink($startFile);
    }
    if (is_file($fixturePath)) {
        @unlink($fixturePath);
    }

    foreach ($processes as &$entry) {
        if (isset($entry['process']) && is_resource($entry['process'])) {
            $statusRow = proc_get_status($entry['process']);
            if ($statusRow['running']) {
                proc_terminate($entry['process']);
            }
        }
    }
    unset($entry);

    if ($ids['tournament'] > 0) {
        $tournamentId = (int) $ids['tournament'];
        $kioskSql = $ids['kiosks'] === [] ? '0' : implode(',', array_map('intval', $ids['kiosks']));
        $db->query(sprintf('DELETE FROM `%1$sscolia_visit_buffers` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_shadow_visits` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_commands` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql));
        $db->query(sprintf('DELETE FROM `%1$sscolia_incidents` WHERE club_id=%2$d', $prefix, (int) $ids['club']));
        $db->query(sprintf('DELETE FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d', $prefix, $tournamentId));
        foreach (['match_statistics', 'live_match_states', 'visits', 'legs'] as $table) {
            $db->query(sprintf(
                'DELETE target FROM `%1$s%2$s` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%3$d',
                $prefix,
                $table,
                $tournamentId
            ));
        }
        $db->query(sprintf('DELETE FROM `%1$smatches` WHERE tournament_id=%2$d', $prefix, $tournamentId));
        $db->query(sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id=%2$d', $prefix, $tournamentId));
        $db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d', $prefix, $tournamentId));
        $db->query(sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=%2$d', $prefix, $tournamentId));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d', $prefix, $tournamentId));
    }
    foreach ($ids['kiosks'] as $kioskId) {
        $db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id=%2$d', $prefix, (int) $kioskId));
    }
    foreach ($ids['players'] as $playerId) {
        $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d', $prefix, (int) $playerId));
    }
    if ($ids['season'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d', $prefix, (int) $ids['season']));
    }
    if ($ids['club'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $prefix, (int) $ids['club']));
    }
    if ($lockHeld) {
        $stmt = $db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->bind_param('s', $lockName);
        $stmt->execute();
        $stmt->close();
    }
}
