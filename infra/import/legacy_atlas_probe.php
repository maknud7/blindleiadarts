<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit(2);
}

$seasonId = trim((string) (getenv('LEGACY_SEASON_ID') ?: ($argv[1] ?? '')));
if ($seasonId === '') {
    throw new RuntimeException('Missing legacy season id.');
}

$host = 'www.' . 'darts' . 'atlas' . '.com';
$base = 'https://' . $host;

$get = static function (string $url): string {
    $ch = curl_init($url);
    if ($ch === false) throw new RuntimeException('Could not initialize curl.');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => 'BlindleiaDarts-HistoryImport/1.0',
        CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml', 'Accept-Language: en-GB,en;q=0.8'],
        CURLOPT_ENCODING => '',
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $effective = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("Legacy HTTP failed ({$status}) {$effective}: {$error}");
    }
    echo "FETCH {$status} " . strlen((string) $body) . " bytes {$effective}\n";
    return (string) $body;
};

$links = static function (string $html): array {
    $out = [];
    if (preg_match_all('/<a\b[^>]*href=["\']([^"\']+)["\']/iu', $html, $matches)) {
        foreach ($matches[1] as $href) {
            $out[] = html_entity_decode((string) $href, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
    }
    return array_values(array_unique($out));
};

$seasonUrl = $base . '/seasons/' . rawurlencode($seasonId);
$seasonHtml = $get($seasonUrl);
$tournamentIds = [];
foreach ([$seasonHtml, $get($seasonUrl . '/tournaments/results'), $get($seasonUrl . '/tournaments/calendar')] as $html) {
    foreach ($links($html) as $href) {
        $path = (string) (parse_url($href, PHP_URL_PATH) ?: $href);
        if (preg_match('~^/tournaments/([^/?#]+)$~', rtrim($path, '/'), $m)) {
            $tournamentIds[$m[1]] = true;
        }
    }
}

echo 'TOURNAMENTS ' . count($tournamentIds) . ': ' . implode(', ', array_keys($tournamentIds)) . "\n";
if ($tournamentIds === []) exit(0);

$firstTournament = (string) array_key_first($tournamentIds);
$tournamentUrl = $base . '/tournaments/' . rawurlencode($firstTournament);
$tournamentHtml = $get($tournamentUrl);
$matchIds = [];
$subpages = [];
foreach ($links($tournamentHtml) as $href) {
    $path = (string) (parse_url($href, PHP_URL_PATH) ?: $href);
    if (preg_match('~^/matches/([^/?#]+)~', $path, $m)) $matchIds[$m[1]] = true;
    if (preg_match('~^/tournaments/' . preg_quote($firstTournament, '~') . '/.+~', $path)) $subpages[$path] = true;
}

foreach (array_slice(array_keys($subpages), 0, 20) as $path) {
    try {
        $html = $get($base . $path);
        foreach ($links($html) as $href) {
            $matchPath = (string) (parse_url($href, PHP_URL_PATH) ?: $href);
            if (preg_match('~^/matches/([^/?#]+)~', $matchPath, $m)) $matchIds[$m[1]] = true;
        }
    } catch (Throwable $e) {
        echo 'SUBPAGE WARN ' . $path . ' ' . $e->getMessage() . "\n";
    }
}

echo 'FIRST TOURNAMENT ' . $firstTournament . '; MATCHES ' . count($matchIds) . ': ' . implode(', ', array_slice(array_keys($matchIds), 0, 12)) . "\n";
if ($matchIds === []) exit(0);

$matchId = (string) array_key_first($matchIds);
$matchHtml = $get($base . '/matches/' . rawurlencode($matchId));
echo "MATCH {$matchId}\n";
if (preg_match('/<title[^>]*>(.*?)<\/title>/isu', $matchHtml, $m)) echo 'TITLE ' . trim(strip_tags($m[1])) . "\n";

if (preg_match_all('/<script\b([^>]*)>(.*?)<\/script>/isu', $matchHtml, $scripts, PREG_SET_ORDER)) {
    echo 'SCRIPTS ' . count($scripts) . "\n";
    foreach ($scripts as $index => $script) {
        $attrs = (string) $script[1];
        $text = trim((string) $script[2]);
        if (preg_match('/src=["\']([^"\']+)/iu', $attrs, $src)) echo "SCRIPT_SRC {$src[1]}\n";
        if ($text !== '' && preg_match('/visit|throw|dart|remaining|score|leg/iu', $text)) {
            $clean = preg_replace('/\s+/u', ' ', $text) ?? $text;
            echo 'SCRIPT_SIGNAL ' . $index . ' ' . mb_substr($clean, 0, 1800) . "\n";
        }
    }
}

$visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $matchHtml) ?? $matchHtml;
$visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
$visible = trim((string) preg_replace('/\s+/u', ' ', strip_tags($visible)));
echo 'VISIBLE ' . mb_substr($visible, 0, 5000) . "\n";

foreach (['data-score', 'data-remaining', 'data-dart', 'data-visit', 'data-player-id', 'phx-value', 'wire:'] as $needle) {
    $count = substr_count(strtolower($matchHtml), strtolower($needle));
    echo 'SIGNAL ' . $needle . '=' . $count . "\n";
}
