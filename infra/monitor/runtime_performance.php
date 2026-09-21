<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$envName = strtoupper(trim((string) (getenv('MONITOR_ENV') ?: 'UNKNOWN')));
$prefix = trim((string) (getenv('DB_TABLE_PREFIX') ?: ''));
$host = (string) (getenv('DB_HOST') ?: '');
$port = (int) (getenv('DB_PORT') ?: 3306);
$dbName = (string) (getenv('DB_NAME') ?: '');
$username = (string) (getenv('DB_USERNAME') ?: '');
$password = (string) (getenv('DB_PASSWORD') ?: '');
$windowMinutes = max(5, min(360, (int) (getenv('MONITOR_WINDOW_MINUTES') ?: 180)));

if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    fwrite(STDERR, "Invalid DB_TABLE_PREFIX.\n");
    exit(2);
}
foreach (['DB_HOST' => $host, 'DB_NAME' => $dbName, 'DB_USERNAME' => $username, 'DB_PASSWORD' => $password] as $name => $value) {
    if ($value === '') {
        fwrite(STDERR, "Missing {$name}.\n");
        exit(2);
    }
}

$table = $prefix . 'activity_events';
$connection = new mysqli($host, $username, $password, $dbName, $port);
$connection->set_charset('utf8mb4');

$sql = "SELECT id,occurred_at,auth_session_id,surface,path,metadata_json
        FROM `{$table}`
        WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND event_name='api_slow'
        ORDER BY occurred_at ASC,id ASC";
$stmt = $connection->prepare($sql);
$stmt->bind_param('i', $windowMinutes);
$stmt->execute();
$rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
$stmt->close();
$connection->close();

function decodeMeta(array $row): array
{
    $raw = trim((string) ($row['metadata_json'] ?? ''));
    if ($raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function shortText(string $value, int $limit = 180): string
{
    $value = preg_replace('/\s+/', ' ', trim($value)) ?: '';
    return mb_substr($value, 0, $limit, 'UTF-8');
}

$groups = [];
foreach ($rows as $row) {
    $metadata = decodeMeta($row);
    $endpoint = (string) ($metadata['endpoint'] ?? '');
    $surface = (string) ($row['surface'] ?? 'unknown');
    $path = (string) ($row['path'] ?? '/');
    $method = (string) ($metadata['method'] ?? 'GET');
    $elapsed = max(0, (int) ($metadata['elapsed_ms'] ?? 0));
    $httpStatus = (int) ($metadata['http_status'] ?? 0);
    $connectionType = (string) ($metadata['effective_connection_type'] ?? '');

    $key = implode('|', [$surface, $path, $method, $endpoint]);
    if (!isset($groups[$key])) {
        $groups[$key] = [
            'count' => 0,
            'surface' => $surface,
            'path' => $path,
            'method' => $method,
            'endpoint' => $endpoint,
            'first' => $row['occurred_at'] ?? null,
            'last' => $row['occurred_at'] ?? null,
            'sum_ms' => 0,
            'max_ms' => 0,
            'min_ms' => null,
            'statuses' => [],
            'sessions' => [],
            'connections' => [],
        ];
    }

    $group =& $groups[$key];
    $group['count']++;
    $group['last'] = $row['occurred_at'] ?? $group['last'];
    $group['sum_ms'] += $elapsed;
    $group['max_ms'] = max($group['max_ms'], $elapsed);
    $group['min_ms'] = $group['min_ms'] === null ? $elapsed : min($group['min_ms'], $elapsed);
    if ($httpStatus > 0) $group['statuses'][$httpStatus] = ($group['statuses'][$httpStatus] ?? 0) + 1;
    $sessionId = isset($row['auth_session_id']) ? (int) $row['auth_session_id'] : 0;
    if ($sessionId > 0) $group['sessions'][$sessionId] = true;
    if ($connectionType !== '') $group['connections'][$connectionType] = ($group['connections'][$connectionType] ?? 0) + 1;
    unset($group);
}

$groups = array_values($groups);
usort($groups, static fn(array $a, array $b): int => [$b['max_ms'], $b['count']] <=> [$a['max_ms'], $a['count']]);

echo "## {$envName} slow API calls — last {$windowMinutes} minutes\n\n";
if ($rows === []) {
    echo "No captured API calls at or above the browser slow-request threshold (5,000 ms).\n\n";
    exit(0);
}

echo sprintf("**%d slow API occurrence%s across %d endpoint group%s.**\n\n",
    count($rows),
    count($rows) === 1 ? '' : 's',
    count($groups),
    count($groups) === 1 ? '' : 's'
);

foreach ($groups as $group) {
    $avg = $group['count'] > 0 ? (int) round($group['sum_ms'] / $group['count']) : 0;
    $endpoint = $group['endpoint'] !== '' ? $group['endpoint'] : $group['path'];
    $statuses = $group['statuses'] !== []
        ? implode(', ', array_map(static fn($status, $count): string => "{$status}×{$count}", array_keys($group['statuses']), array_values($group['statuses'])))
        : 'n/a';
    $connections = $group['connections'] !== []
        ? implode(', ', array_map(static fn($type, $count): string => "{$type}×{$count}", array_keys($group['connections']), array_values($group['connections'])))
        : 'unknown';

    echo sprintf(
        "- **%dx %s %s** · max **%d ms** · avg %d ms · min %d ms · surface `%s`\n",
        $group['count'],
        shortText($group['method'], 12),
        shortText($endpoint),
        $group['max_ms'],
        $avg,
        (int) ($group['min_ms'] ?? 0),
        shortText($group['surface'], 32)
    );
    echo "  - Page: `" . shortText($group['path'], 220) . "`\n";
    echo "  - HTTP: {$statuses}\n";
    echo "  - Effective connection: {$connections}\n";
    echo "  - Affected authenticated sessions: " . count($group['sessions']) . "\n";
    echo "  - First/last: {$group['first']} / {$group['last']}\n";
}
echo "\n";

exit(0);
