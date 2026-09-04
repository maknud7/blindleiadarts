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
$windowMinutes = max(5, min(180, (int) (getenv('MONITOR_WINDOW_MINUTES') ?: 65)));

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

$sql = "SELECT id,occurred_at,auth_session_id,surface,event_name,path,tournament_id,metadata_json
        FROM `{$table}`
        WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND (
            event_name LIKE '%error%'
            OR event_name IN ('js_unhandled_rejection','resource_error')
          )
        ORDER BY occurred_at ASC,id ASC";
$stmt = $connection->prepare($sql);
$stmt->bind_param('i', $windowMinutes);
$stmt->execute();
$rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
$stmt->close();
$connection->close();

function meta(array $row): array
{
    $raw = trim((string) ($row['metadata_json'] ?? ''));
    if ($raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function short(string $value, int $limit = 160): string
{
    $value = preg_replace('/\s+/', ' ', trim($value)) ?: '';
    return mb_substr($value, 0, $limit, 'UTF-8');
}

$groups = [];
foreach ($rows as $row) {
    $metadata = meta($row);
    $signatureParts = [
        (string) ($row['event_name'] ?? ''),
        (string) ($row['surface'] ?? ''),
        (string) ($row['path'] ?? ''),
        (string) ($metadata['endpoint'] ?? ''),
        (string) ($metadata['error_code'] ?? ''),
        (string) ($metadata['source_file'] ?? ''),
        (string) ($metadata['line'] ?? ''),
    ];
    $signature = substr(hash('sha256', implode('|', $signatureParts)), 0, 12);
    if (!isset($groups[$signature])) {
        $groups[$signature] = [
            'count' => 0,
            'first' => $row['occurred_at'] ?? null,
            'last' => $row['occurred_at'] ?? null,
            'sessions' => [],
            'event_name' => (string) ($row['event_name'] ?? 'error'),
            'surface' => (string) ($row['surface'] ?? 'unknown'),
            'path' => (string) ($row['path'] ?? '/'),
            'tournament_id' => isset($row['tournament_id']) ? (int) $row['tournament_id'] : null,
            'endpoint' => (string) ($metadata['endpoint'] ?? ''),
            'method' => (string) ($metadata['method'] ?? ''),
            'http_status' => isset($metadata['http_status']) ? (int) $metadata['http_status'] : null,
            'error_code' => (string) ($metadata['error_code'] ?? ''),
            'error_message' => (string) ($metadata['error_message'] ?? ''),
            'elapsed_ms' => isset($metadata['elapsed_ms']) ? (int) $metadata['elapsed_ms'] : null,
            'source_file' => (string) ($metadata['source_file'] ?? ''),
            'line' => isset($metadata['line']) ? (int) $metadata['line'] : null,
            'column' => isset($metadata['column']) ? (int) $metadata['column'] : null,
            'stack' => (string) ($metadata['stack'] ?? ''),
            'signature' => $signature,
        ];
    }
    $groups[$signature]['count']++;
    $groups[$signature]['last'] = $row['occurred_at'] ?? $groups[$signature]['last'];
    $sessionId = isset($row['auth_session_id']) ? (int) $row['auth_session_id'] : 0;
    if ($sessionId > 0) $groups[$signature]['sessions'][$sessionId] = true;
}

usort($groups, static function (array $a, array $b): int {
    return [$b['count'], (string) $b['last']] <=> [$a['count'], (string) $a['last']];
});

$total = count($rows);
$heading = "## {$envName} runtime errors — last {$windowMinutes} minutes";
$lines = [$heading, ''];

if ($total === 0) {
    $lines[] = 'No captured user-facing JS/API/resource errors in this window.';
    $lines[] = '';
} else {
    $lines[] = sprintf('**%d captured occurrence%s across %d signature%s.**', $total, $total === 1 ? '' : 's', count($groups), count($groups) === 1 ? '' : 's');
    $lines[] = '';
    foreach ($groups as $group) {
        $location = $group['endpoint'] !== '' ? $group['endpoint'] : $group['path'];
        $status = $group['http_status'] !== null && $group['http_status'] > 0 ? ' HTTP ' . $group['http_status'] : '';
        $code = $group['error_code'] !== '' ? ' · ' . short($group['error_code'], 80) : '';
        $lines[] = sprintf(
            '- **%dx %s** · `%s`%s%s · `%s` · signature `%s`',
            $group['count'],
            $group['event_name'],
            short($location, 180),
            $status,
            $code,
            $group['surface'],
            $group['signature']
        );
        if ($group['error_message'] !== '') $lines[] = '  - Message: ' . short($group['error_message'], 260);
        if ($group['method'] !== '') $lines[] = '  - Method: ' . short($group['method'], 16);
        if ($group['source_file'] !== '') {
            $source = short($group['source_file'], 180);
            if ($group['line']) $source .= ':' . $group['line'];
            if ($group['column']) $source .= ':' . $group['column'];
            $lines[] = '  - Source: `' . $source . '`';
        }
        if ($group['tournament_id']) $lines[] = '  - Tournament: ' . $group['tournament_id'];
        if ($group['elapsed_ms'] !== null) $lines[] = '  - Elapsed: ' . $group['elapsed_ms'] . ' ms';
        $lines[] = '  - Affected authenticated sessions: ' . count($group['sessions']);
        $lines[] = '  - First/last: ' . $group['first'] . ' / ' . $group['last'];
        if ($group['stack'] !== '') {
            $firstStackLine = short(strtok($group['stack'], "\n") ?: '', 240);
            if ($firstStackLine !== '') $lines[] = '  - Stack: `' . $firstStackLine . '`';
        }
    }
    $lines[] = '';
}

$report = implode("\n", $lines) . "\n";
echo $report;

$summaryFile = getenv('GITHUB_STEP_SUMMARY');
if (is_string($summaryFile) && $summaryFile !== '') {
    file_put_contents($summaryFile, $report, FILE_APPEND);
}

if ($total > 0) {
    fwrite(STDERR, "Captured {$total} runtime error occurrence(s) in {$envName}.\n");
    exit(1);
}

exit(0);
