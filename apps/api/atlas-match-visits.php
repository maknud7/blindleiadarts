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

$matchId = trim((string) ($_GET['match'] ?? ''));
if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $matchId)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_match_id']);
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
    return [
        'status' => $status,
        'body' => $body === false ? '' : (string) $body,
        'error' => $error,
        'effective_url' => $effective,
    ];
};

$parseNumericLeg = static function (string $segment, string $playerA, string $playerB, int $legNumber): array {
    $prefixText = $playerA . ' ' . $playerB . ' ';
    if (str_starts_with($segment, $prefixText)) {
        $segment = substr($segment, strlen($prefixText));
    } else {
        $posA = mb_stripos($segment, $playerA, 0, 'UTF-8');
        $posB = mb_stripos($segment, $playerB, 0, 'UTF-8');
        if ($posA === false || $posB === false || $posB < $posA) {
            throw new RuntimeException("Leg {$legNumber}: player header not found");
        }
        $segment = mb_substr($segment, $posB + mb_strlen($playerB, 'UTF-8'), null, 'UTF-8');
    }

    $supportPos = mb_stripos($segment, ' Support Guides', 0, 'UTF-8');
    if ($supportPos !== false) {
        $segment = mb_substr($segment, 0, $supportPos, 'UTF-8');
    }

    preg_match_all('/\b\d+\b/u', $segment, $matches);
    $numbers = array_map('intval', $matches[0] ?? []);
    if (count($numbers) < 9) {
        throw new RuntimeException("Leg {$legNumber}: too few numeric values");
    }

    $parsed = null;
    $totalNumbers = count($numbers);
    for ($tailStart = 6; $tailStart < $totalNumbers; $tailStart++) {
        if ($tailStart % 3 !== 0 || $numbers[$tailStart] !== 1) {
            continue;
        }

        // DartsAtlas renders row numbers (1,2,3...) after the visit triplets. On the
        // final leg, player/tournament summary statistics can follow those row numbers.
        // Only consume the consecutive row-number sequence and ignore the footer.
        $rowCount = 0;
        for ($j = $tailStart; $j < $totalNumbers && $rowCount < 60; $j++) {
            $expected = $rowCount + 1;
            if ($numbers[$j] !== $expected) {
                break;
            }
            $rowCount++;
        }
        if ($rowCount < 1) {
            continue;
        }

        $triplets = [];
        for ($i = 0; $i < $tailStart; $i += 3) {
            $darts = $numbers[$i];
            $finalRemaining = $numbers[$i + 1];
            $score = $numbers[$i + 2];
            if ($darts < 1 || $darts > 3 || $finalRemaining < 0 || $finalRemaining > 501 || $score < 0 || $score > 180) {
                $triplets = [];
                break;
            }
            $triplets[] = ['darts_used' => $darts, 'final_remaining' => $finalRemaining, 'score' => $score];
        }
        if (count($triplets) < 2) {
            continue;
        }

        $remainingA = $triplets[0]['final_remaining'];
        $split = null;
        foreach ($triplets as $index => $triplet) {
            if ($triplet['final_remaining'] !== $remainingA) {
                $split = $index;
                break;
            }
        }
        if ($split === null || $split < 1 || $split >= count($triplets)) {
            continue;
        }
        $remainingB = $triplets[$split]['final_remaining'];
        if ($remainingA === $remainingB || !in_array(0, [$remainingA, $remainingB], true)) {
            continue;
        }
        $constantB = true;
        for ($i = $split; $i < count($triplets); $i++) {
            if ($triplets[$i]['final_remaining'] !== $remainingB) {
                $constantB = false;
                break;
            }
        }
        if (!$constantB) {
            continue;
        }

        $a = array_slice($triplets, 0, $split);
        $b = array_slice($triplets, $split);
        if (max(count($a), count($b)) !== $rowCount) {
            continue;
        }
        $sumA = array_sum(array_column($a, 'score'));
        $sumB = array_sum(array_column($b, 'score'));
        if ($sumA + $remainingA !== 501 || $sumB + $remainingB !== 501) {
            continue;
        }

        $decorate = static function (array $visits): array {
            $remaining = 501;
            $result = [];
            foreach ($visits as $index => $visit) {
                $remaining -= (int) $visit['score'];
                $result[] = [
                    'visit_number' => $index + 1,
                    'score' => (int) $visit['score'],
                    'darts_used' => (int) $visit['darts_used'],
                    'remaining_after' => $remaining,
                ];
            }
            return $result;
        };

        $parsed = [
            'leg_number' => $legNumber,
            'winner_side' => $remainingA === 0 ? 'a' : 'b',
            'player_a_final_remaining' => $remainingA,
            'player_b_final_remaining' => $remainingB,
            'player_a_visits' => $decorate($a),
            'player_b_visits' => $decorate($b),
        ];
        break;
    }

    if ($parsed === null) {
        throw new RuntimeException("Leg {$legNumber}: could not identify visit blocks");
    }
    return $parsed;
};

$response = $fetch('https://www.dartsatlas.com/matches/' . $matchId);
if ($response['status'] !== 200 || $response['body'] === '') {
    http_response_code(502);
    echo json_encode([
        'ok' => false,
        'error' => 'atlas_fetch_failed',
        'status' => $response['status'],
        'curl_error' => $response['error'],
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

$body = $response['body'];
$visible = preg_replace('/<script\b[^>]*>.*?<\/script>/isu', ' ', $body) ?? $body;
$visible = preg_replace('/<style\b[^>]*>.*?<\/style>/isu', ' ', $visible) ?? $visible;
$visibleText = $clean($visible);

if (!preg_match('/^(.+?)\s+vs\s+(.+?)\s+Sign Up\b/u', $visibleText, $header)) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'player_header_not_found', 'match' => $matchId], JSON_UNESCAPED_UNICODE);
    exit;
}
$playerA = trim($header[1]);
$playerB = trim($header[2]);

$parts = preg_split('/\bLeg\s+(\d+)\s+/u', $visibleText, -1, PREG_SPLIT_DELIM_CAPTURE);
$legs = [];
try {
    for ($i = 1; $i + 1 < count($parts); $i += 2) {
        $legNumber = (int) $parts[$i];
        $legs[] = $parseNumericLeg((string) $parts[$i + 1], $playerA, $playerB, $legNumber);
    }
} catch (Throwable $error) {
    http_response_code(422);
    echo json_encode([
        'ok' => false,
        'error' => 'visit_parse_failed',
        'message' => $error->getMessage(),
        'match' => $matchId,
        'players' => ['a' => $playerA, 'b' => $playerB],
        'visible_text' => mb_substr($visibleText, 0, 20000),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

if ($legs === []) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'no_legs_found', 'match' => $matchId]);
    exit;
}

$winsA = 0;
$winsB = 0;
$visitCount = 0;
$dartsCount = 0;
foreach ($legs as $leg) {
    if ($leg['winner_side'] === 'a') $winsA++; else $winsB++;
    foreach (['player_a_visits', 'player_b_visits'] as $key) {
        $visitCount += count($leg[$key]);
        foreach ($leg[$key] as $visit) $dartsCount += (int) $visit['darts_used'];
    }
}

echo json_encode([
    'ok' => true,
    'external_id' => $matchId,
    'source_url' => $response['effective_url'],
    'players' => ['a' => $playerA, 'b' => $playerB],
    'legs_won' => ['a' => $winsA, 'b' => $winsB],
    'leg_count' => count($legs),
    'visit_count' => $visitCount,
    'darts_count' => $dartsCount,
    'legs' => $legs,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);