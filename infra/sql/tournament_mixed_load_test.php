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

const MIX_LOCK_WAIT_SECONDS = 1;
const MIX_SLOW_MS = 500.0;
const MIX_HARD_MS = 1500.0;
const MIX_WORKER_DEADLINE_SECONDS = 45;

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
function mixFixture(string $path): array
{
    $raw = file_get_contents($path);
    if ($raw === false) throw new RuntimeException('Could not read mixed-load fixture.');
    $fixture = json_decode($raw, true);
    if (!is_array($fixture)) throw new RuntimeException('Invalid mixed-load fixture JSON.');
    return $fixture;
}

/** @return array{database:Database,db:mysqli,prefix:string} */
function mixDb(string $root): array
{
    $config = Config::load($root . '/apps/api');
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    if ($prefix !== 'bd_test_') {
        throw new RuntimeException('Tournament mixed-load test is TEST-only. Refusing prefix ' . $prefix);
    }
    $db->query('SET SESSION innodb_lock_wait_timeout=' . MIX_LOCK_WAIT_SECONDS);
    try {
        $db->query('SET SESSION max_execution_time=' . (int) MIX_HARD_MS);
    } catch (Throwable) {
        // Some MariaDB variants do not expose MySQL max_execution_time.
    }
    return ['database' => $database, 'db' => $db, 'prefix' => $prefix];
}

function mixProgressPath(array $fixture, string $worker, int $id): string
{
    return rtrim((string) $fixture['progress_dir'], '/') . '/' . preg_replace('/[^a-z0-9_-]+/i', '_', $worker . '-' . $id) . '.json';
}

/** @param array<string,mixed> $payload */
function mixWriteProgress(string $path, array $payload): void
{
    $payload['at'] = microtime(true);
    @file_put_contents($path, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
}

/**
 * @param array<string,mixed> $metrics
 * @return mixed
 */
function mixTimed(array &$metrics, string $progressPath, string $operation, callable $callback): mixed
{
    mixWriteProgress($progressPath, [
        'worker' => $metrics['worker'],
        'worker_id' => $metrics['worker_id'],
        'phase' => 'running',
        'operation' => $operation,
        'ops' => $metrics['ops'],
    ]);
    $started = microtime(true);
    try {
        $result = $callback();
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
    }
    $elapsed = (microtime(true) - $started) * 1000;
    $metrics['ops'] = (int) $metrics['ops'] + 1;
    $metrics['max_ms'] = max((float) $metrics['max_ms'], $elapsed);
    if ($elapsed >= MIX_SLOW_MS) {
        $metrics['slow_ops'] = (int) $metrics['slow_ops'] + 1;
        $metrics['slowest'][] = ['operation' => $operation, 'ms' => round($elapsed, 1)];
        usort($metrics['slowest'], static fn(array $a, array $b): int => $b['ms'] <=> $a['ms']);
        $metrics['slowest'] = array_slice($metrics['slowest'], 0, 5);
    }
    mixWriteProgress($progressPath, [
        'worker' => $metrics['worker'],
        'worker_id' => $metrics['worker_id'],
        'phase' => 'done',
        'operation' => $operation,
        'elapsed_ms' => round($elapsed, 1),
        'ops' => $metrics['ops'],
    ]);
    if ($elapsed > MIX_HARD_MS) {
        throw new RuntimeException(sprintf(
            'Operation exceeded %.0f ms hard limit: %s %.1f ms',
            MIX_HARD_MS,
            $operation,
            $elapsed
        ));
    }
    return $result;
}

function mixWaitForBarrier(array $fixture): void
{
    $deadline = microtime(true) + 15;
    while (!is_file((string) $fixture['start_file'])) {
        if (microtime(true) >= $deadline) throw new RuntimeException('Start barrier timed out.');
        usleep(10000);
    }
}

/** @return array<string,mixed> */
function mixWorker(string $root, string $worker, int $id, array $fixture): array
{
    mixWaitForBarrier($fixture);
    $ctx = mixDb($root);
    /** @var Database $database */
    $database = $ctx['database'];
    /** @var mysqli $db */
    $db = $ctx['db'];
    $prefix = $ctx['prefix'];
    $progressPath = mixProgressPath($fixture, $worker, $id);
    $metrics = [
        'worker' => $worker,
        'worker_id' => $id,
        'ops' => 0,
        'max_ms' => 0.0,
        'slow_ops' => 0,
        'slowest' => [],
    ];
    mixWriteProgress($progressPath, ['worker' => $worker, 'worker_id' => $id, 'phase' => 'started', 'operation' => 'bootstrap', 'ops' => 0]);

    $clubId = (int) $fixture['club_id'];
    $tournamentId = (int) $fixture['tournament_id'];
    $kioskIds = array_map('intval', $fixture['kiosk_ids']);

    if ($worker === 'scolia-queue') {
        $repo = new ScoliaRepository($database);
        $queue = new ScoliaQueueService(
            $database,
            $repo,
            new ScoliaScoringService($repo, new CanonicalScoringService($database), new Dart501Rules())
        );
        for ($round = 0; $round < 100; $round++) {
            $result = mixTimed($metrics, $progressPath, 'scolia.queue.drain', static fn() => $queue->drain(25, $kioskIds));
            if ((int) ($result['claimed'] ?? 0) === 0) break;
            usleep(random_int(1000, 5000));
        }
    } elseif ($worker === 'scolia-command') {
        $repo = new ScoliaRepository($database);
        $queue = new ScoliaQueueService(
            $database,
            $repo,
            new ScoliaScoringService($repo, new CanonicalScoringService($database), new Dart501Rules())
        );
        for ($round = 0; $round < 100; $round++) {
            $commands = mixTimed($metrics, $progressPath, 'scolia.commands.poll', static fn() => $queue->pollCommands($kioskIds, 40));
            foreach ($commands as $command) {
                mixTimed($metrics, $progressPath, 'scolia.commands.ack', static fn() => $repo->completeCommand((int) $command['id'], 'acked'));
            }
            if ($commands === []) break;
            usleep(random_int(1000, 4000));
        }
    } elseif ($worker === 'manual-score') {
        $manual = array_map('intval', $fixture['manual_kiosk_ids']);
        $kioskId = $manual[$id % count($manual)];
        $scoring = new MatchScoringRepository($database);
        mixTimed($metrics, $progressPath, 'match.start', static fn() => $scoring->startMatch($kioskId));
        for ($visit = 1; $visit <= 15; $visit++) {
            $requestId = sprintf('mix-%s-manual-%d-%d', $fixture['suffix'], $id, $visit);
            mixTimed($metrics, $progressPath, 'match.record_visit', static fn() => $scoring->recordVisit($kioskId, [
                'input_mode' => 'sum',
                'score' => 20,
                'darts_used' => 3,
                'request_id' => $requestId,
            ]));
            if ($visit % 5 === 0) {
                mixTimed($metrics, $progressPath, 'match.undo', static fn() => $scoring->undoLastVisit($kioskId));
                mixTimed($metrics, $progressPath, 'match.record_visit.redo', static fn() => $scoring->recordVisit($kioskId, [
                    'input_mode' => 'sum',
                    'score' => 20,
                    'darts_used' => 3,
                    'request_id' => $requestId . '-redo',
                ]));
            }
            usleep(random_int(1000, 6000));
        }
    } elseif ($worker === 'pause') {
        $breaks = new PlayerBreakRepository($database);
        $players = array_map('intval', $fixture['break_player_ids']);
        for ($round = 0; $round < 5; $round++) {
            foreach ($players as $playerId) {
                mixTimed($metrics, $progressPath, 'pause.request', static fn() => $breaks->requestBreak($tournamentId, $playerId));
                mixTimed($metrics, $progressPath, 'pause.expire', static function () use ($db, $prefix, $tournamentId, $playerId): void {
                    $stmt = $db->prepare(sprintf(
                        'UPDATE `%1$stournament_player_breaks` SET ends_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE tournament_id=? AND player_id=? AND status="active"',
                        $prefix
                    ));
                    $stmt->bind_param('ii', $tournamentId, $playerId);
                    $stmt->execute();
                    $stmt->close();
                });
                mixTimed($metrics, $progressPath, 'pause.normalize', static fn() => $breaks->normalizeTournament($tournamentId));
            }
        }
    } elseif ($worker === 'tournament-engine') {
        $ops = new TournamentOperationsRepository($database);
        for ($round = 1; $round <= 25; $round++) {
            mixTimed($metrics, $progressPath, 'engine.snapshot', static fn() => $ops->snapshot($tournamentId));
            if ($round % 3 === 0) {
                mixTimed($metrics, $progressPath, 'engine.reconcile', static fn() => $ops->reconcileTournament($tournamentId));
            }
            if ($round % 5 === 0) {
                $kioskId = $kioskIds[$round % count($kioskIds)];
                mixTimed($metrics, $progressPath, 'engine.kiosk_post_match', static fn() => $ops->kioskPostMatch($kioskId));
            }
            usleep(random_int(1000, 5000));
        }
    } elseif ($worker === 'admin') {
        $ops = new TournamentOperationsRepository($database);
        for ($round = 1; $round <= 30; $round++) {
            mixTimed($metrics, $progressPath, 'admin.auto_assign_toggle', static fn() => $ops->updateAutoAssignEnabled($tournamentId, ($round % 2) === 0));
            usleep(random_int(1000, 5000));
        }
        mixTimed($metrics, $progressPath, 'admin.auto_assign_restore', static fn() => $ops->updateAutoAssignEnabled($tournamentId, true));
    } elseif ($worker === 'reader') {
        for ($round = 1; $round <= 60; $round++) {
            mixTimed($metrics, $progressPath, 'live.matches', static function () use ($db, $prefix, $tournamentId): void {
                $stmt = $db->prepare(sprintf(
                    'SELECT m.id,m.status,m.kiosk_id,COUNT(v.id) visits
                     FROM `%1$smatches` m LEFT JOIN `%1$svisits` v ON v.match_id=m.id
                     WHERE m.tournament_id=? GROUP BY m.id,m.status,m.kiosk_id ORDER BY m.id',
                    $prefix
                ));
                $stmt->bind_param('i', $tournamentId);
                $stmt->execute();
                $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                $stmt->close();
            });
            if ($round % 2 === 0) {
                mixTimed($metrics, $progressPath, 'live.scolia_queue', static function () use ($db, $prefix, $clubId): void {
                    $stmt = $db->prepare(sprintf('SELECT processing_status,COUNT(*) c FROM `%1$sscolia_events` WHERE club_id=? GROUP BY processing_status', $prefix));
                    $stmt->bind_param('i', $clubId);
                    $stmt->execute();
                    $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                    $stmt->close();
                });
            }
            if ($round % 3 === 0) {
                mixTimed($metrics, $progressPath, 'live.players', static function () use ($db, $prefix, $tournamentId): void {
                    $stmt = $db->prepare(sprintf('SELECT status,COUNT(*) c FROM `%1$stournament_players` WHERE tournament_id=? GROUP BY status', $prefix));
                    $stmt->bind_param('i', $tournamentId);
                    $stmt->execute();
                    $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                    $stmt->close();
                });
            }
            usleep(random_int(500, 3500));
        }
    } elseif ($worker === 'scolia-runtime') {
        $repo = new ScoliaRepository($database);
        for ($round = 1; $round <= 10; $round++) {
            foreach ($kioskIds as $kioskId) {
                mixTimed($metrics, $progressPath, 'runtime.heartbeat', static fn() => $repo->bridgeHeartbeat($kioskId, 'connected'));
                mixTimed($metrics, $progressPath, 'runtime.status', static fn() => $repo->updateRuntimeStatus($kioskId, [
                    'boardStatus' => 'READY',
                    'boardPhase' => ($round % 2 === 0) ? 'Throw' : 'Takeout',
                ]));
            }
        }
    } else {
        throw new RuntimeException('Unknown worker: ' . $worker);
    }

    $metrics['max_ms'] = round((float) $metrics['max_ms'], 1);
    mixWriteProgress($progressPath, [
        'worker' => $worker,
        'worker_id' => $id,
        'phase' => 'finished',
        'operation' => 'complete',
        'ops' => $metrics['ops'],
        'max_ms' => $metrics['max_ms'],
    ]);
    return $metrics;
}

$worker = mixArg('worker');
if ($worker !== null) {
    $fixturePath = mixArg('fixture');
    if ($fixturePath === null) exit(2);
    try {
        echo json_encode(mixWorker($root, $worker, (int) (mixArg('id') ?? 0), mixFixture($fixturePath)), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
        exit(0);
    } catch (Throwable $error) {
        fwrite(STDERR, sprintf('%s#%s failed: %s%s', $worker, mixArg('id') ?? '0', $error->getMessage(), PHP_EOL));
        exit(1);
    }
}

$ctx = mixDb($root);
/** @var mysqli $db */
$db = $ctx['db'];
/** @var Database $database */
$database = $ctx['database'];
$prefix = $ctx['prefix'];
$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};
$scalar = static function (string $sql) use ($db): int {
    return (int) (($db->query($sql)->fetch_row()[0] ?? 0));
};
$q = static function (string $value) use ($db): string {
    return "'" . $db->real_escape_string($value) . "'";
};

$suffix = strtolower(substr(bin2hex(random_bytes(8)), 0, 12));
$fixturePath = sys_get_temp_dir() . '/bd-mix-' . $suffix . '.json';
$startFile = sys_get_temp_dir() . '/bd-mix-start-' . $suffix;
$progressDir = sys_get_temp_dir() . '/bd-mix-progress-' . $suffix;
@mkdir($progressDir, 0777, true);
$lockName = $prefix . 'tournament-mixed-load-test';
$lockHeld = false;
$processes = [];
$ids = ['club' => 0, 'season' => 0, 'tournament' => 0, 'kiosks' => [], 'players' => [], 'matches' => []];
$startedAt = microtime(true);

function mixCleanup(mysqli $db, string $prefix, array $ids, string $fixturePath, string $startFile, string $progressDir): void
{
    @unlink($fixturePath);
    @unlink($startFile);
    foreach (glob($progressDir . '/*.json') ?: [] as $path) @unlink($path);
    @rmdir($progressDir);
    if ((int) $ids['club'] <= 0) return;
    $clubId = (int) $ids['club'];
    $tournamentId = (int) $ids['tournament'];
    $kioskSql = $ids['kiosks'] === [] ? '0' : implode(',', array_map('intval', $ids['kiosks']));
    $playerSql = $ids['players'] === [] ? '0' : implode(',', array_map('intval', $ids['players']));
    $queries = [
        sprintf('DELETE FROM `%1$sscolia_visit_buffers` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$sscolia_shadow_visits` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$sscolia_events` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$sscolia_commands` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$sscolia_incidents` WHERE club_id=%2$d', $prefix, $clubId),
        sprintf('DELETE FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE target FROM `%1$smatch_statistics` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE target FROM `%1$slive_match_states` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE target FROM `%1$svisits` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE target FROM `%1$slegs` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$smatches` WHERE tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d', $prefix, $tournamentId),
        sprintf('DELETE FROM `%1$sscolia_board_settings` WHERE kiosk_id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$skiosks` WHERE id IN (%2$s)', $prefix, $kioskSql),
        sprintf('DELETE FROM `%1$splayers` WHERE id IN (%2$s)', $prefix, $playerSql),
        sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d', $prefix, (int) $ids['season']),
        sprintf('DELETE FROM `%1$sscolia_club_settings` WHERE club_id=%2$d', $prefix, $clubId),
        sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $prefix, $clubId),
    ];
    foreach ($queries as $sql) {
        try { $db->query($sql); } catch (Throwable $error) { fwrite(STDERR, 'Cleanup warning: ' . $error->getMessage() . PHP_EOL); }
    }
}

try {
    $stmt = $db->prepare('SELECT GET_LOCK(?,120)');
    $stmt->bind_param('s', $lockName);
    $stmt->execute();
    $lockHeld = (int) ($stmt->get_result()->fetch_row()[0] ?? 0) === 1;
    $stmt->close();
    $assert($lockHeld, 'Could not acquire mixed-load test lock.');

    $clubName = 'Tournament Mix ' . $suffix;
    $clubSlug = 'tournament-mix-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name,slug) VALUES (?,?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $seasonName = 'Tournament Mix Season ' . $suffix;
    $starts = date('Y-m-d');
    $ends = date('Y-m-d', strtotime('+1 month'));
    $active = 1;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sseasons` (club_id,name,starts_on,ends_on,is_active) VALUES (?,?,?,?,?)', $prefix));
    $stmt->bind_param('isssi', $ids['club'], $seasonName, $starts, $ends, $active);
    $stmt->execute();
    $ids['season'] = (int) $stmt->insert_id;
    $stmt->close();

    $tournamentName = 'Tournament Mix ' . $suffix;
    $tournamentSlug = 'tournament-mix-' . $suffix;
    $status = 'in_progress';
    $startAt = date('Y-m-d H:i:s');
    $autoAssign = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$stournaments` (club_id,season_id,name,slug,provider_system,status,start_at,auto_assign_enabled) VALUES (?,?,?,? ,"local",?,?,?)',
        $prefix
    ));
    $stmt->bind_param('iissssi', $ids['club'], $ids['season'], $tournamentName, $tournamentSlug, $status, $startAt, $autoAssign);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    for ($i = 1; $i <= 24; $i++) {
        $name = sprintf('Mix Player %02d %s', $i, $suffix);
        $stmt = $db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id,display_name) VALUES (?,?)', $prefix));
        $stmt->bind_param('is', $ids['club'], $name);
        $stmt->execute();
        $playerId = (int) $stmt->insert_id;
        $stmt->close();
        $ids['players'][] = $playerId;
        $stmt = $db->prepare(sprintf('INSERT INTO `%1$stournament_players` (tournament_id,player_id,status,registration_source) VALUES (?,? ,"checked_in","mixed_load")', $prefix));
        $stmt->bind_param('ii', $ids['tournament'], $playerId);
        $stmt->execute();
        $stmt->close();
    }

    for ($board = 1; $board <= 10; $board++) {
        $code = sprintf('MIX-%s-%02d', strtoupper(substr($suffix, 0, 6)), $board);
        $name = 'Mix Board ' . $board;
        $number = 9800 + $board;
        $mode = $board <= 6 ? 'scolia' : 'manual';
        $stmt = $db->prepare(sprintf('INSERT INTO `%1$skiosks` (club_id,code,name,board_number,is_active,scoring_mode) VALUES (?,?,?,?,1,?)', $prefix));
        $stmt->bind_param('issis', $ids['club'], $code, $name, $number, $mode);
        $stmt->execute();
        $kioskId = (int) $stmt->insert_id;
        $stmt->close();
        $ids['kiosks'][$board] = $kioskId;
        $stmt = $db->prepare(sprintf('INSERT INTO `%1$stournament_kiosks` (tournament_id,kiosk_id,sort_order) VALUES (?,?,?)', $prefix));
        $stmt->bind_param('iii', $ids['tournament'], $kioskId, $board);
        $stmt->execute();
        $stmt->close();
        $serial = sprintf('MIX-%s-%02d', strtoupper($suffix), $board);
        $boardMode = $board <= 6 ? 'live' : 'off';
        $stmt = $db->prepare(sprintf('INSERT INTO `%1$sscolia_board_settings` (kiosk_id,serial_number,mode,auto_fallback_to_manual) VALUES (?,?,?,1)', $prefix));
        $stmt->bind_param('iss', $kioskId, $serial, $boardMode);
        $stmt->execute();
        $stmt->close();
    }

    $token = 'mixed-load-test';
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sscolia_club_settings` (club_id,enabled,access_token,queue_max_attempts,queue_retry_base_seconds) VALUES (?,0,?,8,1)', $prefix));
    $stmt->bind_param('is', $ids['club'], $token);
    $stmt->execute();
    $stmt->close();

    for ($board = 1; $board <= 10; $board++) {
        $a = $ids['players'][($board - 1) * 2];
        $b = $ids['players'][($board - 1) * 2 + 1];
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$smatches` (tournament_id,kiosk_id,round_label,round_number,status,best_of_legs,legs_to_win,player_a_id,player_b_id) VALUES (?,? ,"Mix",1,"assigned",9,5,?,?)',
            $prefix
        ));
        $stmt->bind_param('iiii', $ids['tournament'], $ids['kiosks'][$board], $a, $b);
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
            for ($cycle = 1; $cycle <= 8; $cycle++) {
                foreach ([1, 2, 3] as $dart) {
                    $provider = sprintf('mix-%s-b%02d-c%02d-d%d', $suffix, $board, $cycle, $dart);
                    $payload = json_encode(['id' => $provider, 'type' => 'THROW_DETECTED', 'payload' => ['sector' => 'S20', 'bounceout' => false]], JSON_UNESCAPED_SLASHES);
                    $eventRows[] = sprintf('(%d,%d,%d,%s,%s,"THROW_DETECTED",%s)', $ids['club'], $kioskId, $matchId, $q($provider), $q(hash('sha256', 'mix:' . $provider)), $q((string) $payload));
                    $expectedEvents++;
                }
                $provider = sprintf('mix-%s-b%02d-c%02d-takeout', $suffix, $board, $cycle);
                $payload = json_encode(['id' => $provider, 'type' => 'TAKEOUT_FINISHED', 'payload' => ['falseTakeout' => false]], JSON_UNESCAPED_SLASHES);
                $eventRows[] = sprintf('(%d,%d,%d,%s,%s,"TAKEOUT_FINISHED",%s)', $ids['club'], $kioskId, $matchId, $q($provider), $q(hash('sha256', 'mix:' . $provider)), $q((string) $payload));
                $expectedEvents++;
            }
            for ($s = 1; $s <= 8; $s++) {
                $provider = sprintf('mix-%s-b%02d-status-%02d', $suffix, $board, $s);
                $payload = json_encode(['id' => $provider, 'type' => 'SBC_STATUS_CHANGED', 'payload' => ['boardStatus' => 'READY', 'boardPhase' => 'Throw']], JSON_UNESCAPED_SLASHES);
                $eventRows[] = sprintf('(%d,%d,%d,%s,%s,"SBC_STATUS_CHANGED",%s)', $ids['club'], $kioskId, $matchId, $q($provider), $q(hash('sha256', 'mix:' . $provider)), $q((string) $payload));
                $expectedEvents++;
            }
        } else {
            for ($s = 1; $s <= 15; $s++) {
                $provider = sprintf('mix-%s-b%02d-off-%02d', $suffix, $board, $s);
                $payload = json_encode(['id' => $provider, 'type' => 'SBC_STATUS_CHANGED', 'payload' => ['boardStatus' => 'READY']], JSON_UNESCAPED_SLASHES);
                $eventRows[] = sprintf('(%d,%d,%d,%s,%s,"SBC_STATUS_CHANGED",%s)', $ids['club'], $kioskId, $matchId, $q($provider), $q(hash('sha256', 'mix:' . $provider)), $q((string) $payload));
                $expectedEvents++;
            }
        }
        if (count($eventRows) >= 100) {
            $db->query(sprintf('INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s', $prefix, implode(',', $eventRows)));
            $eventRows = [];
        }
    }
    if ($eventRows !== []) $db->query(sprintf('INSERT INTO `%1$sscolia_events` (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,payload_json) VALUES %2$s', $prefix, implode(',', $eventRows)));
    $assert($expectedEvents === 300, 'Fixture must contain 300 Scolia events.');

    $commandRows = [];
    $expectedCommands = 0;
    $types = ['PING', 'START_MATCH', 'UNDO_LAST_VISIT', 'SYNC_STATE'];
    for ($board = 1; $board <= 10; $board++) {
        for ($i = 1; $i <= 15; $i++) {
            $type = $types[($i - 1) % count($types)];
            $message = sprintf('mix-%s-command-b%02d-%03d', $suffix, $board, $i);
            $payload = json_encode(['mixed' => true, 'board' => $board, 'sequence' => $i]);
            $commandRows[] = sprintf('(%d,%d,%s,%s,%s)', $ids['club'], $ids['kiosks'][$board], $q($type), $q($message), $q((string) $payload));
            $expectedCommands++;
        }
    }
    $db->query(sprintf('INSERT INTO `%1$sscolia_commands` (club_id,kiosk_id,command_type,message_id,payload_json) VALUES %2$s', $prefix, implode(',', $commandRows)));
    $assert($expectedCommands === 150, 'Fixture must contain 150 Scolia commands.');

    $fixture = [
        'suffix' => $suffix,
        'start_file' => $startFile,
        'progress_dir' => $progressDir,
        'club_id' => $ids['club'],
        'tournament_id' => $ids['tournament'],
        'kiosk_ids' => array_values($ids['kiosks']),
        'manual_kiosk_ids' => array_values(array_slice($ids['kiosks'], 6, 4, true)),
        'break_player_ids' => array_slice($ids['players'], 20, 4),
        'expected_events' => $expectedEvents,
        'expected_commands' => $expectedCommands,
    ];
    file_put_contents($fixturePath, json_encode($fixture, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

    $workers = [
        ['scolia-queue', 0], ['scolia-queue', 1], ['scolia-queue', 2],
        ['scolia-command', 0], ['scolia-command', 1],
        ['manual-score', 0], ['manual-score', 1], ['manual-score', 2], ['manual-score', 3],
        ['pause', 0], ['tournament-engine', 0], ['admin', 0],
        ['reader', 0], ['reader', 1], ['scolia-runtime', 0],
    ];

    foreach ($workers as [$name, $id]) {
        $pipes = [];
        $command = sprintf('%s %s --worker=%s --id=%d --fixture=%s', escapeshellarg(PHP_BINARY), escapeshellarg(__FILE__), escapeshellarg($name), $id, escapeshellarg($fixturePath));
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) throw new RuntimeException('Could not start ' . $name . '#' . $id);
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $processes[] = ['name' => $name, 'id' => $id, 'process' => $process, 'stdout' => $pipes[1], 'stderr' => $pipes[2], 'output' => '', 'error' => '', 'exit' => null];
    }
    touch($startFile);

    $deadline = microtime(true) + MIX_WORKER_DEADLINE_SECONDS;
    while (true) {
        $running = 0;
        foreach ($processes as &$entry) {
            if ($entry['exit'] !== null) continue;
            $entry['output'] .= stream_get_contents($entry['stdout']);
            $entry['error'] .= stream_get_contents($entry['stderr']);
            $statusRow = proc_get_status($entry['process']);
            if ($statusRow['running']) {
                $running++;
                continue;
            }
            $entry['exit'] = (int) $statusRow['exitcode'];
            $entry['output'] .= stream_get_contents($entry['stdout']);
            $entry['error'] .= stream_get_contents($entry['stderr']);
            fclose($entry['stdout']);
            fclose($entry['stderr']);
            proc_close($entry['process']);
        }
        unset($entry);
        if ($running === 0) break;
        if (microtime(true) >= $deadline) {
            $stuck = [];
            foreach ($processes as &$entry) {
                if ($entry['exit'] !== null) continue;
                $progressPath = mixProgressPath($fixture, $entry['name'], $entry['id']);
                $progress = is_file($progressPath) ? json_decode((string) file_get_contents($progressPath), true) : null;
                $stuck[] = sprintf(
                    '%s#%d at %s/%s after %s ops',
                    $entry['name'],
                    $entry['id'],
                    is_array($progress) ? (string) ($progress['phase'] ?? '?') : '?',
                    is_array($progress) ? (string) ($progress['operation'] ?? '?') : '?',
                    is_array($progress) ? (string) ($progress['ops'] ?? '?') : '?'
                );
                proc_terminate($entry['process'], 9);
            }
            unset($entry);
            usleep(300000);
            throw new RuntimeException('Workers exceeded ' . MIX_WORKER_DEADLINE_SECONDS . 's: ' . implode(' | ', $stuck));
        }
        usleep(50000);
    }

    $results = [];
    foreach ($processes as $entry) {
        $assert($entry['exit'] === 0, sprintf('%s#%d failed: %s', $entry['name'], $entry['id'], trim((string) $entry['error'])));
        $lines = array_values(array_filter(array_map('trim', explode("\n", trim((string) $entry['output'])))));
        $decoded = json_decode((string) ($lines === [] ? '' : end($lines)), true);
        $assert(is_array($decoded), sprintf('%s#%d returned invalid metrics.', $entry['name'], $entry['id']));
        $results[] = $decoded;
    }

    $eventLike = $db->real_escape_string('mix-' . $suffix . '-%');
    $eventCount = $scalar(sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s"', $prefix, $eventLike));
    $assert($eventCount === $expectedEvents, 'Scolia event count changed.');
    $unfinishedEvents = $scalar(sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s" AND processing_status IN ("queued","processing","failed","dead_letter")', $prefix, $eventLike));
    $assert($unfinishedEvents === 0, 'Scolia event(s) did not reach terminal success/ignored state.');
    $retryEvents = $scalar(sprintf('SELECT COUNT(*) FROM `%1$sscolia_events` WHERE provider_event_id LIKE "%2$s" AND attempt_count<>1', $prefix, $eventLike));
    $assert($retryEvents === 0, 'Scolia event was retried or skipped.');
    $fifo = $scalar(sprintf(
        'SELECT COUNT(*) FROM `%1$sscolia_events` later INNER JOIN `%1$sscolia_events` earlier ON earlier.kiosk_id=later.kiosk_id AND earlier.id<later.id
         WHERE later.provider_event_id LIKE "%2$s" AND earlier.provider_event_id LIKE "%2$s" AND later.processed_at IS NOT NULL AND earlier.processed_at IS NOT NULL AND later.processed_at<earlier.processed_at',
        $prefix, $eventLike
    ));
    $assert($fifo === 0, 'Per-board FIFO completion order was violated.');

    $commandLike = $db->real_escape_string('mix-' . $suffix . '-command-%');
    $acked = $scalar(sprintf('SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE message_id LIKE "%2$s" AND status="acked"', $prefix, $commandLike));
    $assert($acked === $expectedCommands, 'Not all Scolia commands were acked.');
    $commandRetries = $scalar(sprintf('SELECT COUNT(*) FROM `%1$sscolia_commands` WHERE message_id LIKE "%2$s" AND attempt_count<>1', $prefix, $commandLike));
    $assert($commandRetries === 0, 'Scolia command was retried or skipped.');

    $manualSql = implode(',', array_map('intval', $fixture['manual_kiosk_ids']));
    $manualVisits = $scalar(sprintf('SELECT COUNT(*) FROM `%1$svisits` v INNER JOIN `%1$smatches` m ON m.id=v.match_id WHERE m.kiosk_id IN (%2$s)', $prefix, $manualSql));
    $assert($manualVisits === 60, 'Manual scoring lost/duplicated visits.');
    $openBreaks = $scalar(sprintf('SELECT COUNT(*) FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d AND status IN ("scheduled","active")', $prefix, $ids['tournament']));
    $assert($openBreaks === 0, 'Pause flow left an active/scheduled break.');
    $breakPlayerSql = implode(',', array_map('intval', $fixture['break_player_ids']));
    $badBreakPlayers = $scalar(sprintf('SELECT COUNT(*) FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id IN (%3$s) AND status<>"checked_in"', $prefix, $ids['tournament'], $breakPlayerSql));
    $assert($badBreakPlayers === 0, 'Pause flow did not restore player status.');

    $totalOps = 0;
    $slowOps = 0;
    $maxMs = 0.0;
    $slowest = [];
    foreach ($results as $result) {
        $totalOps += (int) ($result['ops'] ?? 0);
        $slowOps += (int) ($result['slow_ops'] ?? 0);
        $maxMs = max($maxMs, (float) ($result['max_ms'] ?? 0));
        foreach (($result['slowest'] ?? []) as $row) {
            $slowest[] = sprintf('%s#%d %s %.1fms', $result['worker'], $result['worker_id'], $row['operation'], $row['ms']);
        }
    }
    echo "Tournament mixed load OK\n";
    echo sprintf("15 workers | %d operations | wall %d ms | max operation %.1f ms | slow >= %.0f ms: %d\n", $totalOps, (int) round((microtime(true) - $startedAt) * 1000), $maxMs, MIX_SLOW_MS, $slowOps);
    echo sprintf("Scolia events %d/%d terminal | commands %d/%d acked | manual visits %d | deadlocks 0 | lock-wait timeouts 0 | FIFO violations 0\n", $eventCount, $expectedEvents, $acked, $expectedCommands, $manualVisits);
    if ($slowest !== []) echo 'Slow samples: ' . implode(' | ', array_slice($slowest, 0, 8)) . PHP_EOL;
} finally {
    foreach ($processes as &$entry) {
        if (!isset($entry['process']) || !is_resource($entry['process'])) continue;
        $statusRow = proc_get_status($entry['process']);
        if ($statusRow['running']) proc_terminate($entry['process'], 9);
    }
    unset($entry);
    usleep(200000);
    mixCleanup($db, $prefix, $ids, $fixturePath, $startFile, $progressDir);
    if ($lockHeld) {
        try {
            $stmt = $db->prepare('SELECT RELEASE_LOCK(?)');
            $stmt->bind_param('s', $lockName);
            $stmt->execute();
            $stmt->close();
        } catch (Throwable) {}
    }
}
