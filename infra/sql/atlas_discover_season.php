<?php

declare(strict_types=1);

$options = getopt('', ['season:']);
$seasonId = trim((string) ($options['season'] ?? ''));
if ($seasonId === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $seasonId)) {
    throw new RuntimeException('Usage: php atlas_discover_season.php --season=<DartsAtlas season id>');
}

$clean = static function (string $value): string {
    $value = html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim((string) preg_replace('/\s+/u', ' ', $value));
};

$url = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonId);
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 40,
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
if ($body === false || $status !== 200) {
    throw new RuntimeException('DartsAtlas season fetch failed: HTTP ' . $status . ($error ? ' ' . $error : ''));
}

$title = null;
if (preg_match('~<title[^>]*>(.*?)</title>~is', $body, $m)) {
    $title = $clean((string) $m[1]);
}

$tournaments = [];
if (preg_match_all('~<a\b[^>]*href=["\'](?:https://www\.dartsatlas\.com)?/tournaments/([A-Za-z0-9_-]+)(?:[^"\']*)["\'][^>]*>(.*?)</a>~is', $body, $matches, PREG_SET_ORDER)) {
    foreach ($matches as $match) {
        $id = (string) $match[1];
        $text = $clean((string) $match[2]);
        if ($text === '') continue;
        if (!isset($tournaments[$id]) || mb_strlen($text) > mb_strlen((string) $tournaments[$id]['text'])) {
            $tournaments[$id] = ['external_id' => $id, 'text' => $text];
        }
    }
}

$visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', (string) $body) ?? (string) $body;
$visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
$visibleText = $clean($visible);

echo json_encode([
    'ok' => true,
    'season_external_id' => $seasonId,
    'status' => $status,
    'effective_url' => $effective,
    'title' => $title,
    'tournaments' => array_values($tournaments),
    'visible_text' => mb_substr($visibleText, 0, 30000),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
