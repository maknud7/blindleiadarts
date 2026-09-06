<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') exit(2);

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
    probeWrite($status, ['state' => 'connecting']);
    try {
        $config = Config::load($root . '/apps/api');
        $database = new Database($config);
        if ($database->tablePrefix() !== 'bd_test_') throw new RuntimeException('TEST prefix required.');
        $started = microtime(true);
        $db = $database->connection();
        $elapsed = (microtime(true) - $started) * 1000;
        $db->query('SELECT 1');
        probeWrite($status, ['state' => 'connected', 'connect_ms' => round($elapsed, 1)]);
        usleep(8000000);
        probeWrite($status, ['state' => 'released', 'connect_ms' => round($elapsed, 1)]);
        exit(0);
    } catch (Throwable $error) {
        $code = (int) $error->getCode();
        probeWrite($status, ['state' => 'failed', 'code' => $code, 'message' => substr($error->getMessage(), 0, 160)]);
        exit(1);
    }
}

$config = Config::load($root . '/apps/api');
$database = new Database($config);
if ($database->tablePrefix() !== 'bd_test_') throw new RuntimeException('TEST prefix required.');
$db = $database->connection();

$server = ['max_connections' => null, 'max_user_connections' => null, 'connect_timeout' => null, 'grant_max_user_connections' => null];
try {
    $row = $db->query('SELECT @@max_connections AS max_connections, @@max_user_connections AS max_user_connections, @@connect_timeout AS connect_timeout')->fetch_assoc();
    foreach (['max_connections', 'max_user_connections', 'connect_timeout'] as $key) {
        if (isset($row[$key])) $server[$key] = (int) $row[$key];
    }
} catch (Throwable) {}
try {
    $result = $db->query('SHOW GRANTS FOR CURRENT_USER');
    while ($row = $result->fetch_row()) {
        $grant = (string) ($row[0] ?? '');
        if (preg_match('/MAX_USER_CONNECTIONS\s+(\d+)/i', $grant, $match)) {
            $server['grant_max_user_connections'] = (int) $match[1];
        }
    }
} catch (Throwable) {}

$count = 15;
$dir = sys_get_temp_dir() . '/bd-db-probe-' . bin2hex(random_bytes(5));
@mkdir($dir, 0777, true);
$barrier = $dir . '/start';
$workers = [];
try {
    for ($i = 0; $i < $count; $i++) {
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
        if (!is_resource($process)) throw new RuntimeException('Could not start DB probe worker.');
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $workers[] = ['process' => $process, 'stdout' => $pipes[1], 'stderr' => $pipes[2], 'status' => $status];
    }
    touch($barrier);
    usleep(4000000);

    $states = ['connected' => 0, 'connecting' => 0, 'failed' => 0, 'ready' => 0, 'released' => 0, 'unknown' => 0];
    $connectTimes = [];
    $failures = [];
    foreach ($workers as $entry) {
        $payload = is_file($entry['status']) ? json_decode((string) file_get_contents($entry['status']), true) : null;
        $state = is_array($payload) ? (string) ($payload['state'] ?? 'unknown') : 'unknown';
        if (!isset($states[$state])) $state = 'unknown';
        $states[$state]++;
        if (is_array($payload) && isset($payload['connect_ms'])) $connectTimes[] = (float) $payload['connect_ms'];
        if ($state === 'failed' && is_array($payload)) $failures[] = ['code' => (int) ($payload['code'] ?? 0), 'message' => (string) ($payload['message'] ?? '')];
    }

    sort($connectTimes);
    $p50 = $connectTimes === [] ? null : $connectTimes[(int) floor((count($connectTimes) - 1) * 0.50)];
    $p95 = $connectTimes === [] ? null : $connectTimes[(int) floor((count($connectTimes) - 1) * 0.95)];

    echo sprintf(
        "DB concurrency probe: connected=%d/%d after 4s, connecting=%d, failed=%d, released=%d\n",
        $states['connected'], $count, $states['connecting'], $states['failed'], $states['released']
    );
    echo sprintf(
        "DB server limits: max_connections=%s, max_user_connections=%s, grant_max_user_connections=%s, connect_timeout=%s\n",
        $server['max_connections'] === null ? 'unknown' : (string) $server['max_connections'],
        $server['max_user_connections'] === null ? 'unknown' : (string) $server['max_user_connections'],
        $server['grant_max_user_connections'] === null ? 'not-exposed' : (string) $server['grant_max_user_connections'],
        $server['connect_timeout'] === null ? 'unknown' : (string) $server['connect_timeout']
    );
    echo sprintf(
        "Connect latency: p50=%s ms, p95=%s ms\n",
        $p50 === null ? 'n/a' : number_format($p50, 1, '.', ''),
        $p95 === null ? 'n/a' : number_format($p95, 1, '.', '')
    );
    foreach (array_slice($failures, 0, 3) as $failure) {
        echo sprintf("Connection failure sample: code=%d message=%s\n", $failure['code'], $failure['message']);
    }

    if ($states['connected'] + $states['released'] < 10) {
        throw new RuntimeException(sprintf(
            'DB concurrency capacity is below safe mixed-load target: only %d/%d simultaneous connections established within 4s.',
            $states['connected'] + $states['released'],
            $count
        ));
    }
} finally {
    foreach ($workers as $entry) {
        if (is_resource($entry['process'])) {
            $status = proc_get_status($entry['process']);
            if ($status['running']) proc_terminate($entry['process'], 9);
        }
        if (is_resource($entry['stdout'])) fclose($entry['stdout']);
        if (is_resource($entry['stderr'])) fclose($entry['stderr']);
    }
    foreach (glob($dir . '/*') ?: [] as $path) @unlink($path);
    @rmdir($dir);
}
