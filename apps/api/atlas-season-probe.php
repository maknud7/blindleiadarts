<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'missing_config']);
    exit;
}
$config = require $configPath;
$prefix = (string) ($config['db']['table_prefix'] ?? '');
if ($prefix !== 'bd_test_') {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'test_only']);
    exit;
}

$seasonId = trim((string) ($_GET['season'] ?? ''));
if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $seasonId)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_season_id']);
    exit;
}

$clean = static function (string $value): string {
    $value = html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};
$fetch = static function (string $url): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: nb-NO,nb;q=0.9,en-GB;q=0.8,en;q=0.7',
            'Cache-Control: no-cache',
            'Pragma: no-cache',
        ],
    ]);
    $body = curl_exec($ch);
    $error = $body === false ? curl_error($ch) : null;
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $effective = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);
    return ['status' => $status, 'effective_url' => $effective, 'body' => $body === false ? '' : (string) $body, 'error' => $error];
};

$base = 'https://www.dartsatlas.com/seasons/' . $seasonId;
$candidates = [
    'root' => $base,
    'results' => $base . '/tournaments/results',
    'calendar' => $base . '/tournaments/calendar',
    'statistics' => $base . '/statistics',
];

$pages = [];
$allTournaments = [];
$anySuccess = false;
foreach ($candidates as $label => $url) {
    $response = $fetch($url);
    $body = $response['body'];
    $anySuccess = $anySuccess || ($response['status'] >= 200 && $response['status'] < 300);
    $tournaments = [];
    if (preg_match_all('~<a\b[^>]*href=["\'](?:https?://www\.dartsatlas\.com)?/tournaments/([A-Za-z0-9_-]+)(?:[^"\']*)["\'][^>]*>(.*?)</a>~is', $body, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $row) {
            $id = (string) $row[1];
            $text = $clean((string) $row[2]);
            if ($text === '') continue;
            $tournaments[$id] = $text;
            $allTournaments[$id] = $text;
        }
    }
    $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $body) ?? $body;
    $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
    $pages[$label] = [
        'source_status' => $response['status'],
        'effective_url' => $response['effective_url'],
        'body_bytes' => strlen($body),
        'tournaments' => $tournaments,
        'visible_text' => mb_substr($clean($visible), 0, 30000),
        'curl_error' => $response['error'],
    ];
}

http_response_code($anySuccess ? 200 : 502);
echo json_encode([
    'ok' => $anySuccess,
    'marker' => 'atlas-season-probe-v3',
    'season_external_id' => $seasonId,
    'tournaments' => $allTournaments,
    'pages' => $pages,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
