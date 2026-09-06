<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') exit(2);

const PROBE_WORKER_COUNT = 15;
const PROBE_HOLD_US = 900000;
const PROBE_DEADLINE_SECONDS = 20;

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function probeArg(string $name): ?string
{
    global $argv;
    $prefix = '--' . $name . '=';
    foreach ($argv as $arg) {
        if (str_starts_with($arg, $prefix)) return substr($arg, strlen($prefix));
    }
    return null;
}

function probeWrite(string $path, array $data): void
{
    $data['at'] = microtime(true);
    @file_put_contents($path, json_encode($data, JSON_UNESCAPED_SLASHES), LOCK_EX);
}

$worker = probeArg('worker');
if ($worker !== null) {
    $barrier = (string) probeArg('barrier');
    $status = (string) probeArg('status');
    $deadline = microtime(true) + 15;
    probeWrite($status, ['state' => 'ready']);
    while (!is_file($barrier)) {
        if (microtime(true) > $deadline) exit(3);
        usleep(10000);
    }

    probeWrite($status, ['state' => 'waiting_for_gate']);
    try {
        $config = Config::load($root . '/apps/api');
        $database = new Database($config);
        if ($database->tablePrefix() !== 'bd_test_') throw new RuntimeException('TEST prefix required.');
        $started = microtime(true);
        $db = $database->connection();
        $connectMs = (microtime(true) - $started) * 1000;
        $db->query('SELECT 1');
        probeWrite($status, [
            'state' => 'connected',
            'connect_ms' => round($connectMs, 1),
            'gate_wait_ms' => round($database->connectionGateWaitMs(), 1),
        ]);
        usleep(PROBE_HOLD_US);
        $database->releaseConnection();
        probeWrite($status, [
            'state' => 'released',
            'connect_ms' => round($connectMs, 1),
            'gate_wait_ms' => round($database->connectionGateWaitMs(), 1),
        ]);
        exit(0);
    } catch (Throwable $error) {
        probeWrite($status, [
            'state' => 'failed',
            'code' => (int) $error->getCode(),
            'message' => substr($error->getMessage(), 0, 180),
        ]);
        exit(1);
    }
}

$config = Config::load($root . '/apps/api');
$database = new Database($config);
if ($database->tablePrefix() !== 'bd_test_') throw new RuntimeException('TEST prefix required.');
$limit = $config->dbMaxConcurrentConnections();
if ($limit <= 0) throw new RuntimeException('DB admission gate must be enabled for this probe.');

$server = ['max_connections' => null, 'max_user_connections' => null, 'connect_timeout' => null, 'grant_max_user_connections' => null];
try {
    // Metadata is read before the worker wave and released immediately so it does
    // not consume one of the measured application slots.
    $metadataDb = new mysqli(
        $config->dbHost(),
        $config->dbUsername(),
        $config->dbPassword(),
        $config->dbName(),
        $config->dbPort()
    );
    $metadataDb->set_charset('utf8mb4');
    $row = $metadataDb->query('SELECT @@max_connections AS max_connections, @@max_user_connections AS max_user_connections, @@connect_timeout AS connect_timeout')->fetch_assoc();
    foreach (['max_connections', 'max_user_connections', 'connect_timeout'] as $key) {
        if (isset($row[$key])) $server[$key] = (int) $row[$key];
    }
    try {
        $result = $metadataDb->query('SHOW GRANTS FOR CURRENT_USER');
        while ($grantRow = $result->fetch_row()) {
            $grant = (string) ($grantRow[0] ?? '');
            if (preg_match('/MAX_USER_CONNECTIONS\s+(\d+)/i', $grant, $match)) {
                $server['grant_max_user_connections'] = (int) $match[1];
            }
        }
    } catch (Throwable) {
    }
    $metadataDb->close();
} catch (Throwable) {
}

$dir = sys_get_temp_dir() . '/bd-db-gate-probe-' . bin2hex(random_bytes(5));
@mkdir($dir, 0777, true);
$barrier = $dir . '/start';
$workers = [];
try {
    for ($i = 0; $i < PROBE_WORKER_COUNT; $i++) {
        $status = $dir . '/worker-' . $i . '.json';
        $pipes = [];
        $cmd = sprintf(
            '%s %s --worker=%d --barrier=%s --status=%s',
            escapeshellarg(PHP_BINARY),
            escapeshellarg(__FILE__),
            $i,
            escapeshellarg($barrier),
            escapeshellarg($status)
        );
        $process = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) throw new RuntimeException('Could not start DB gate probe worker.');
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $workers[] = ['process' => $process, 'stdout' => $pipes[1], 'stderr' => $pipes[2], 'status' => $status];
    }

    $readyDeadline = microtime(true) + 5;
    do {
        $ready = 0;
        foreach ($workers as $entry) {
            $payload = is_file($entry['status']) ? json_decode((string) file_get_contents($entry['status']), true) : null;
            if (is_array($payload) && ($payload['state'] ?? '') === 'ready') $ready++;
        }
        if ($ready === PROBE_WORKER_COUNT) break;
        usleep(20000);
    } while (microtime(true) < $readyDeadline);

    touch($barrier);
    $deadline = microtime(true) + PROBE_DEADLINE_SECONDS;
    $peakConnected = 0;
    $final = [];
    while (microtime(true) < $deadline) {
        $connected = 0;
        $complete = 0;
        $final = [];
        foreach ($workers as $entry) {
            $payload = is_file($entry['status']) ? json_decode((string) file_get_contents($entry['status']), true) : null;
            if (!is_array($payload)) continue;
            $final[] = $payload;
            $state = (string) ($payload['state'] ?? '');
            if ($state === 'connected') $connected++;
            if (in_array($state, ['released', 'failed'], true)) $complete++;
        }
        $peakConnected = max($peakConnected, $connected);
        if ($complete === PROBE_WORKER_COUNT) break;
        usleep(10000);
    }

    $released = 0;
    $failed = 0;
    $queued = 0;
    $maxWaitMs = 0.0;
    $failures = [];
    foreach ($workers as $entry) {
        $payload = is_file($entry['status']) ? json_decode((string) file_get_contents($entry['status']), true) : null;
        $state = is_array($payload) ? (string) ($payload['state'] ?? 'unknown') : 'unknown';
        if ($state === 'released') $released++;
        if ($state === 'failed') {
            $failed++;
            $failures[] = is_array($payload) ? (string) ($payload['message'] ?? 'unknown') : 'unknown';
        }
        $waitMs = is_array($payload) ? (float) ($payload['gate_wait_ms'] ?? 0) : 0.0;
        if ($waitMs >= 50) $queued++;
        $maxWaitMs = max($maxWaitMs, $waitMs);
    }

    echo sprintf(
        "DB admission gate: limit=%d | workers=%d | peak_connected=%d | queued=%d | released=%d | failed=%d | max_gate_wait=%.1f ms\n",
        $limit,
        PROBE_WORKER_COUNT,
        $peakConnected,
        $queued,
        $released,
        $failed,
        $maxWaitMs
    );
    echo sprintf(
        "DB server limits: max_connections=%s, max_user_connections=%s, grant_max_user_connections=%s, connect_timeout=%s\n",
        $server['max_connections'] === null ? 'unknown' : (string) $server['max_connections'],
        $server['max_user_connections'] === null ? 'unknown' : (string) $server['max_user_connections'],
        $server['grant_max_user_connections'] === null ? 'not-exposed' : (string) $server['grant_max_user_connections'],
        $server['connect_timeout'] === null ? 'unknown' : (string) $server['connect_timeout']
    );

    if ($failed > 0) {
        throw new RuntimeException('DB gate worker failed: ' . implode(' | ', array_slice($failures, 0, 3)));
    }
    if ($released !== PROBE_WORKER_COUNT) {
        throw new RuntimeException(sprintf('DB gate did not drain all workers: released=%d/%d.', $released, PROBE_WORKER_COUNT));
    }
    if ($peakConnected > $limit) {
        throw new RuntimeException(sprintf('DB gate exceeded configured limit: peak=%d limit=%d.', $peakConnected, $limit));
    }
    if ($peakConnected < min($limit, PROBE_WORKER_COUNT)) {
        throw new RuntimeException(sprintf('DB gate did not exercise full configured capacity: peak=%d limit=%d.', $peakConnected, $limit));
    }
    if ($queued < max(1, PROBE_WORKER_COUNT - $limit)) {
        throw new RuntimeException(sprintf('DB gate did not queue the expected worker wave: queued=%d.', $queued));
    }
    echo "DB admission gate probe OK\n";
} finally {
    foreach ($workers as $entry) {
        if (is_resource($entry['process'])) {
            $status = proc_get_status($entry['process']);
            if ($status['running']) proc_terminate($entry['process'], 9);
            @proc_close($entry['process']);
        }
        if (is_resource($entry['stdout'])) fclose($entry['stdout']);
        if (is_resource($entry['stderr'])) fclose($entry['stderr']);
    }
    foreach (glob($dir . '/*') ?: [] as $path) @unlink($path);
    @rmdir($dir);
}
