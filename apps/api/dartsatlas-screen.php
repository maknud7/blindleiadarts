<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

require_once __DIR__ . '/../packages/connectors/DartsAtlas/DartsAtlasHttpClient.php';
require_once __DIR__ . '/../packages/connectors/DartsAtlas/DartsAtlasHtmlParser.php';

const DEFAULT_SEASON = 'rFByCgOqI1rq';

function out(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function safe_id(mixed $value, string $fallback = ''): string {
    $value = trim((string) $value);
    return preg_match('/^[A-Za-z0-9_-]+$/', $value) ? $value : $fallback;
}
function read_json(string $file): ?array {
    if (!is_file($file)) return null;
    $data = json_decode((string) @file_get_contents($file), true);
    return is_array($data) ? $data : null;
}
function write_json(string $file, array $data): void {
    @file_put_contents($file, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
}
function norm_name(mixed $value): string {
    return mb_strtolower(preg_replace('/\s+/u', ' ', trim((string) $value)) ?? trim((string) $value));
}
function fetch_tournament(DartsAtlasHttpClient $http, DartsAtlasHtmlParser $parser, string $id): array {
    $url = 'https://www.dartsatlas.com/tournaments/' . rawurlencode($id);
    return $parser->parseTournament($http->get($url)->body, $url);
}
function discover(DartsAtlasHttpClient $http, DartsAtlasHtmlParser $parser, string $seasonId, string $cacheFile): array {
    $cached = read_json($cacheFile);
    if ($cached && time() - (int) ($cached['time'] ?? 0) < 45 && safe_id($cached['id'] ?? '') !== '') return $cached;

    $base = 'https://www.dartsatlas.com/seasons/' . rawurlencode($seasonId);
    $seasonName = 'Mandagsserien Høst 2026';
    $candidates = [];
    foreach ([$base . '/tournaments/calendar', $base . '/tournaments/results', $base] as $url) {
        try {
            $season = $parser->parseSeason($http->get($url)->body, $base);
            if (!empty($season['name'])) $seasonName = (string) $season['name'];
            foreach ($season['tournaments'] ?? [] as $t) {
                $id = safe_id($t['external_id'] ?? '');
                if ($id !== '') $candidates[$id] = $t;
            }
        } catch (Throwable) {}
    }
    if (!$candidates) {
        if ($cached && safe_id($cached['id'] ?? '') !== '') return $cached;
        throw new RuntimeException('Fant ingen turnering i DartsAtlas-sesongen.');
    }

    $ids = array_keys($candidates);
    $ids = array_values(array_unique(array_merge(array_slice($ids, 0, 4), array_slice($ids, -4))));
    $best = null;
    foreach ($ids as $index => $id) {
        try { $t = fetch_tournament($http, $parser, $id); } catch (Throwable) { continue; }
        $live = $pending = $done = 0;
        foreach ($t['matches'] ?? [] as $m) {
            $s = (string) ($m['status'] ?? 'pending');
            $s === 'in_progress' ? $live++ : ($s === 'completed' ? $done++ : $pending++);
        }
        $score = $live * 100000 + $pending * 1000 + $done * 10 + $index;
        if ($best === null || $score > $best['score']) $best = ['id' => $id, 'score' => $score, 'parsed' => $t];
    }
    if ($best === null) $best = ['id' => end($ids), 'score' => 0, 'parsed' => null];
    $result = ['id' => (string) $best['id'], 'season_name' => $seasonName, 'time' => time()];
    write_json($cacheFile, $result);
    if (is_array($best['parsed'])) $result['parsed'] = $best['parsed'];
    return $result;
}
function broadcast_player(array $players, array $target): ?array {
    $id = trim((string) ($target['external_id'] ?? ''));
    $name = norm_name($target['name'] ?? '');
    foreach ($players as $p) {
        if (!is_array($p)) continue;
        if ($id !== '' && trim((string) ($p['external_id'] ?? '')) === $id) return $p;
        if ($name !== '' && norm_name($p['name'] ?? '') === $name) return $p;
    }
    return null;
}
function player(array $base, ?array $live, int $legs, ?float $avg, bool $winner): array {
    $live ??= [];
    return [
        'id' => $base['external_id'] ?? null,
        'name' => (string) ($base['name'] ?? 'Ukjent'),
        'display_name' => (string) ($base['name'] ?? 'Ukjent'),
        'nickname' => null,
        'score' => isset($live['score']) ? (int) $live['score'] : null,
        'legs' => isset($live['legs']) ? (int) $live['legs'] : $legs,
        'winner' => $winner,
        'stats' => [
            'average' => isset($live['average']) ? (float) $live['average'] : $avg,
            'first_nine' => isset($live['first_nine_average']) ? (float) $live['first_nine_average'] : null,
            'darts_thrown' => isset($live['darts_thrown']) ? (int) $live['darts_thrown'] : null,
            'checkout_hits' => isset($live['checkout_hits']) ? (int) $live['checkout_hits'] : null,
            'checkout_attempts' => isset($live['checkout_attempts']) ? (int) $live['checkout_attempts'] : null,
            'highest_checkout' => isset($live['highest_checkout']) ? (int) $live['highest_checkout'] : null,
            '180s' => isset($live['score_180']) ? (int) $live['score_180'] : 0,
        ],
    ];
}
function format_match(DartsAtlasHttpClient $http, DartsAtlasHtmlParser $parser, array $m): ?array {
    if (!is_array($m['player_a'] ?? null) || !is_array($m['player_b'] ?? null)) return null;
    $id = safe_id($m['external_id'] ?? '');
    $broadcast = [];
    if (($m['status'] ?? '') === 'in_progress' && $id !== '' && !str_starts_with($id, 'derived-')) {
        try {
            $url = 'https://www.dartsatlas.com/matches/' . rawurlencode($id) . '/broadcast?mode=dual_cam_stats';
            $broadcast = $parser->parseBroadcast($http->get($url)->body, $id);
        } catch (Throwable) {}
    }
    $bp = is_array($broadcast['players'] ?? null) ? $broadcast['players'] : [];
    $la = (int) ($m['player_a_legs'] ?? 0); $lb = (int) ($m['player_b_legs'] ?? 0);
    $need = max(1, (int) ($m['legs_to_win'] ?? 1));
    $status = (string) ($m['status'] ?? 'pending');
    return [
        'id' => $id,
        'provider_match_id' => $id,
        'status' => $status,
        'round' => $m['round_label'] ?? null,
        'bracket' => null,
        'best_of_legs' => (int) ($m['best_of_legs'] ?? 1),
        'legs_to_win' => $need,
        'board' => ['number' => isset($m['board_number']) ? (int) $m['board_number'] : null, 'name' => null],
        'players' => [
            'a' => player($m['player_a'], broadcast_player($bp, $m['player_a']), $la, isset($m['average_a']) ? (float) $m['average_a'] : null, $status === 'completed' && $la >= $need && $la > $lb),
            'b' => player($m['player_b'], broadcast_player($bp, $m['player_b']), $lb, isset($m['average_b']) ? (float) $m['average_b'] : null, $status === 'completed' && $lb >= $need && $lb > $la),
        ],
    ];
}

$seasonId = safe_id($_GET['season_id'] ?? DEFAULT_SEASON, DEFAULT_SEASON);
$requested = safe_id($_GET['tournament_id'] ?? '');
$dir = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'blindleia-da-screen';
@mkdir($dir, 0770, true);
$key = hash('sha256', $seasonId . '|' . $requested);
$payloadFile = $dir . '/payload-' . $key . '.json';
$selectionFile = $dir . '/selection-' . hash('sha256', $seasonId) . '.json';
$cached = read_json($payloadFile);
if ($cached && is_file($payloadFile) && time() - (int) filemtime($payloadFile) < 2) out($cached);

try {
    $http = new DartsAtlasHttpClient('BlindleiaDarts-Screen/1.0', 5, 15);
    $parser = new DartsAtlasHtmlParser();
    if ($requested !== '') {
        $tournamentId = $requested; $seasonName = 'Mandagsserien Høst 2026'; $parsed = null;
    } else {
        $selection = discover($http, $parser, $seasonId, $selectionFile);
        $tournamentId = (string) $selection['id'];
        $seasonName = (string) ($selection['season_name'] ?? 'Mandagsserien Høst 2026');
        $parsed = is_array($selection['parsed'] ?? null) ? $selection['parsed'] : null;
    }
    $t = $parsed ?? fetch_tournament($http, $parser, $tournamentId);
    $live = []; $upcoming = []; $recent = []; $all = [];
    foreach ($t['matches'] ?? [] as $m) {
        if (!is_array($m) || !($fm = format_match($http, $parser, $m))) continue;
        $all[] = $fm;
        $fm['status'] === 'in_progress' ? $live[] = $fm : ($fm['status'] === 'completed' ? $recent[] = $fm : $upcoming[] = $fm);
    }
    $total180 = 0; $high = null; $bestAvg = null;
    foreach ($all as $m) foreach (['a','b'] as $side) {
        $p = $m['players'][$side]; $s = $p['stats']; $total180 += (int) ($s['180s'] ?? 0);
        $co = (int) ($s['highest_checkout'] ?? 0);
        if ($co > 0 && ($high === null || $co > $high['value'])) $high = ['value' => $co, 'player' => $p];
        if ($s['average'] !== null && ($bestAvg === null || (float) $s['average'] > $bestAvg['value'])) $bestAvg = ['value' => (float) $s['average'], 'player' => $p];
    }
    $payload = [
        'ok' => true,
        'generated_at' => gmdate('c'),
        'source' => 'dartsatlas_scrape',
        'tournament' => ['id' => $tournamentId, 'name' => trim((string) ($t['name'] ?? '')) ?: 'Blindleia Darts', 'status' => $live ? 'in_progress' : ($upcoming ? 'ready' : 'completed'), 'season_name' => $seasonName, 'club_name' => 'Blindleia Dartklubb'],
        'feed' => ['status' => $live ? 'live' : 'idle', 'age_seconds' => 0, 'last_seen_at' => gmdate('c'), 'source' => 'DartsAtlas direct scrape'],
        'matches' => ['live' => array_slice($live,0,8), 'upcoming' => array_slice($upcoming,0,8), 'recent' => array_slice(array_reverse($recent),0,8)],
        'highlights' => ['total_180' => $total180, 'highest_checkout' => $high, 'best_average' => $bestAvg],
        'leaderboard' => [],
    ];
    write_json($payloadFile, $payload);
    out($payload);
} catch (Throwable $e) {
    if ($cached) {
        $cached['feed']['status'] = 'stale';
        $cached['feed']['age_seconds'] = is_file($payloadFile) ? max(0, time() - (int) filemtime($payloadFile)) : null;
        $cached['feed']['error'] = $e->getMessage();
        out($cached);
    }
    out(['ok' => false, 'error' => 'dartsatlas_screen_unavailable', 'detail' => $e->getMessage(), 'generated_at' => gmdate('c')], 503);
}
