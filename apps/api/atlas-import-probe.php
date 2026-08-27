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
    echo json_encode(['ok' => false, 'error' => 'test_only', 'prefix' => $prefix]);
    exit;
}

$url = 'https://www.dartsatlas.com/tournaments/fpC4m4hIZdjZ';
$headers = [];
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_ENCODING => '',
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    CURLOPT_HTTPHEADER => [
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language: nb-NO,nb;q=0.9,en-GB;q=0.8,en;q=0.7',
        'Cache-Control: no-cache',
        'Pragma: no-cache',
    ],
    CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) {
            $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        }
        return strlen($line);
    },
]);
$body = curl_exec($ch);
$error = $body === false ? curl_error($ch) : null;
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$effective = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
curl_close($ch);

$body = $body === false ? '' : (string) $body;
$matchIds = [];
if (preg_match_all('~/matches/([A-Za-z0-9_-]+)~', $body, $m)) {
    $matchIds = array_values(array_unique($m[1]));
}
$players = [];
if (preg_match_all('~/(?:players|player)/([A-Za-z0-9_-]+)[^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
    foreach ($m as $row) {
        $name = trim(html_entity_decode(strip_tags((string) $row[2]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        if ($name !== '') {
            $players[(string) $row[1]] = preg_replace('/\s+/u', ' ', $name);
        }
    }
}
$title = null;
if (preg_match('~<title[^>]*>(.*?)</title>~is', $body, $m)) {
    $title = trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

$cloudflare = stripos($body, 'cloudflare') !== false || stripos($body, 'cf-chl-') !== false;

echo json_encode([
    'ok' => $status >= 200 && $status < 300,
    'status' => $status,
    'effective_url' => $effective,
    'content_type' => $headers['content-type'] ?? null,
    'body_bytes' => strlen($body),
    'title' => $title,
    'cloudflare' => $cloudflare,
    'match_count' => count($matchIds),
    'match_ids' => $matchIds,
    'player_count' => count($players),
    'players' => $players,
    'curl_error' => $error,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
