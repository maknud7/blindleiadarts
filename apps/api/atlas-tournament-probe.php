<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

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

$tournamentId = trim((string) ($_GET['tournament'] ?? ''));
if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $tournamentId)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_tournament_id']);
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
    return ['status' => $status, 'body' => $body === false ? '' : (string) $body, 'error' => $error, 'effective_url' => $effective];
};

$base = 'https://www.dartsatlas.com/tournaments/' . $tournamentId;
$candidates = [
    'root' => $base,
    'groups' => $base . '/groups',
    'group-1' => $base . '/group/1',
    'group-2' => $base . '/group/2',
    'group-3' => $base . '/group/3',
    'group-4' => $base . '/group/4',
    'results' => $base . '/results',
];

$pages = [];
foreach ($candidates as $label => $url) {
    $response = $fetch($url);
    $body = $response['body'];
    $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $body) ?? $body;
    $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
    $visibleText = $clean($visible);

    $players = [];
    if (preg_match_all('~<a\b[^>]*href=["\']([^"\']*player_stats/([^"\'/?#]+)[^"\']*)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $name = $clean((string) $row[3]);
            $name = trim((string) (preg_replace('/^Champion\s+/iu', '', $name) ?? $name));
            if ($name !== '') $players[(string) $row[2]] = $name;
        }
    }

    $matches = [];
    if (preg_match_all('~<a\b[^>]*href=["\'](?:https?://www\.dartsatlas\.com)?/matches/([A-Za-z0-9_-]+)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $labelText = $clean((string) $row[2]);
            if ($labelText !== '') $matches[(string) $row[1]] = $labelText;
        }
    }

    $pages[$label] = [
        'status' => $response['status'],
        'effective_url' => $response['effective_url'],
        'body_bytes' => strlen($body),
        'players' => $players,
        'matches' => $matches,
        'visible_text' => mb_substr($visibleText, 0, 16000),
        'curl_error' => $response['error'],
    ];
    usleep(1200000);
}

echo json_encode([
    'ok' => true,
    'tournament_external_id' => $tournamentId,
    'pages' => $pages,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
