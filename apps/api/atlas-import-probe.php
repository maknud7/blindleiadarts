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

$tournamentId = 'fpC4m4hIZdjZ';
$base = 'https://www.dartsatlas.com/tournaments/' . $tournamentId;
$candidates = [
    '' => $base,
    'groups' => $base . '/groups',
    'group' => $base . '/group',
    'group-1' => $base . '/group/1',
    'group-2' => $base . '/group/2',
    'bracket' => $base . '/bracket',
    'knockout' => $base . '/knockout',
    'results' => $base . '/results',
    'matches' => $base . '/matches',
    'schedule' => $base . '/schedule',
];

$clean = static function (string $value): string {
    $value = html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};

$fetch = static function (string $url): array {
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
    return [
        'status' => $status,
        'body' => $body === false ? '' : (string) $body,
        'error' => $error,
        'effective_url' => $effective,
        'content_type' => $headers['content-type'] ?? null,
    ];
};

$pages = [];
foreach ($candidates as $label => $url) {
    $response = $fetch($url);
    $body = $response['body'];
    $title = null;
    if (preg_match('~<title[^>]*>(.*?)</title>~is', $body, $m)) {
        $title = $clean($m[1]);
    }

    $matchIds = [];
    if (preg_match_all('~/matches/([A-Za-z0-9_-]+)~', $body, $m)) {
        $matchIds = array_values(array_unique($m[1]));
    }

    $players = [];
    if (preg_match_all('~<a\b[^>]*href=["\']([^"\']*(?:player_stats|/players/|/profiles/)[^"\']*)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $href = html_entity_decode((string) $row[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $name = $clean((string) $row[2]);
            if ($name === '') continue;
            $players[$href] = $name;
        }
    }

    $links = [];
    if (preg_match_all('~<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>~is', $body, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $href = html_entity_decode((string) $row[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if (str_contains($href, $tournamentId) || preg_match('~/(matches|group|groups|bracket|knockout|results|schedule)(?:/|$)~i', $href)) {
                $links[$href] = $clean((string) $row[2]);
            }
        }
    }

    $bestOfTexts = [];
    if ($body !== '' && class_exists(DOMDocument::class)) {
        $dom = new DOMDocument();
        $old = libxml_use_internal_errors(true);
        $loaded = $dom->loadHTML('<?xml encoding="utf-8" ?>' . $body, LIBXML_NOWARNING | LIBXML_NOERROR);
        libxml_clear_errors();
        libxml_use_internal_errors($old);
        if ($loaded) {
            $xpath = new DOMXPath($dom);
            $nodes = $xpath->query('//*[self::li or self::tr or self::article or self::section or self::div][contains(normalize-space(.), "Best of")]');
            if ($nodes !== false) {
                foreach ($nodes as $node) {
                    $text = $clean((string) ($node->textContent ?? ''));
                    if ($text === '' || mb_strlen($text) > 1000 || !preg_match('/\bBest\s+of\s+\d+\b/i', $text)) continue;
                    $bestOfTexts[$text] = true;
                    if (count($bestOfTexts) >= 80) break;
                }
            }
        }
    }

    $visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $body) ?? $body;
    $visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
    $visibleText = $clean($visible);

    $pages[$label === '' ? 'root' : $label] = [
        'status' => $response['status'],
        'effective_url' => $response['effective_url'],
        'content_type' => $response['content_type'],
        'body_bytes' => strlen($body),
        'title' => $title,
        'cloudflare' => stripos($body, 'cloudflare') !== false || stripos($body, 'cf-chl-') !== false,
        'match_ids' => $matchIds,
        'players' => $players,
        'links' => $links,
        'best_of_texts' => array_keys($bestOfTexts),
        'visible_text' => mb_substr($visibleText, 0, 12000),
        'curl_error' => $response['error'],
    ];
}

echo json_encode([
    'ok' => true,
    'tournament_external_id' => $tournamentId,
    'pages' => $pages,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
