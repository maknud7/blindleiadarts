<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Only GET is allowed.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$matchId = filter_input(INPUT_GET, 'match_id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if (!$matchId) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => ['code' => 'match_id_required', 'message' => 'match_id is required.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $database = new Database(Config::load(__DIR__));
    $connection = $database->connection();
    $prefix = $database->tablePrefix();

    $sql = sprintf(
        'SELECT e.match_id,e.tournament_id,e.season_id,e.player_a_id,e.player_b_id,
                e.rating_a_before,e.rating_b_before,e.rating_a_after,e.rating_b_after,
                e.delta_a,e.delta_b,e.matches_before_a,e.matches_before_b,e.k_a,e.k_b,e.applied_at
         FROM `%1$selo_match_events` e
         WHERE e.match_id=? AND e.status="applied"
         ORDER BY e.id DESC LIMIT 1',
        $prefix
    );
    $stmt = $connection->prepare($sql);
    $stmt->bind_param('i', $matchId);
    $stmt->execute();
    $event = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    // Compatibility fallback: ledger snapshots also carry match-specific ELO context.
    if ($event === null) {
        $snapshotSql = sprintf(
            'SELECT rs.player_id,rs.tournament_id,rs.season_id,rs.points,rs.context_json,rs.calculated_at,
                    m.player_a_id,m.player_b_id
             FROM `%1$sranking_snapshots` rs
             INNER JOIN `%1$smatches` m ON m.id=?
             WHERE rs.ranking_type="elo"
               AND rs.player_id IN (m.player_a_id,m.player_b_id)
               AND JSON_UNQUOTE(JSON_EXTRACT(rs.context_json,"$.match_id"))=CAST(? AS CHAR)
             ORDER BY rs.id ASC',
            $prefix
        );
        $snapshot = $connection->prepare($snapshotSql);
        $snapshot->bind_param('ii', $matchId, $matchId);
        $snapshot->execute();
        $rows = $snapshot->get_result()->fetch_all(MYSQLI_ASSOC);
        $snapshot->close();
        if (count($rows) >= 2) {
            $first = $rows[0];
            $playerAId = (int) $first['player_a_id'];
            $playerBId = (int) $first['player_b_id'];
            $byPlayer = [];
            foreach ($rows as $row) {
                $context = is_string($row['context_json'] ?? null) ? json_decode((string) $row['context_json'], true) : null;
                if (!is_array($context)) continue;
                $byPlayer[(int) $row['player_id']] = [
                    'before' => isset($context['rating_before']) ? (float) $context['rating_before'] : null,
                    'after' => isset($context['rating_after']) ? (float) $context['rating_after'] : (float) $row['points'],
                    'delta' => isset($context['delta']) ? (float) $context['delta'] : null,
                    'matches_before' => isset($context['matches_before']) ? (int) $context['matches_before'] : null,
                    'k' => isset($context['k']) ? (float) $context['k'] : null,
                ];
            }
            if (isset($byPlayer[$playerAId], $byPlayer[$playerBId])) {
                $event = [
                    'match_id' => $matchId,
                    'tournament_id' => (int) $first['tournament_id'],
                    'season_id' => $first['season_id'] !== null ? (int) $first['season_id'] : null,
                    'player_a_id' => $playerAId,
                    'player_b_id' => $playerBId,
                    'rating_a_before' => $byPlayer[$playerAId]['before'],
                    'rating_b_before' => $byPlayer[$playerBId]['before'],
                    'rating_a_after' => $byPlayer[$playerAId]['after'],
                    'rating_b_after' => $byPlayer[$playerBId]['after'],
                    'delta_a' => $byPlayer[$playerAId]['delta'],
                    'delta_b' => $byPlayer[$playerBId]['delta'],
                    'matches_before_a' => $byPlayer[$playerAId]['matches_before'],
                    'matches_before_b' => $byPlayer[$playerBId]['matches_before'],
                    'k_a' => $byPlayer[$playerAId]['k'],
                    'k_b' => $byPlayer[$playerBId]['k'],
                    'applied_at' => $first['calculated_at'],
                ];
            }
        }
    }

    if ($event !== null) {
        foreach (['match_id','tournament_id','season_id','player_a_id','player_b_id','matches_before_a','matches_before_b'] as $field) {
            if (array_key_exists($field, $event) && $event[$field] !== null) $event[$field] = (int) $event[$field];
        }
        foreach (['rating_a_before','rating_b_before','rating_a_after','rating_b_after','delta_a','delta_b','k_a','k_b'] as $field) {
            if (array_key_exists($field, $event) && $event[$field] !== null) $event[$field] = (float) $event[$field];
        }
    }

    echo json_encode(['ok' => true, 'data' => ['match_id' => (int) $matchId, 'event' => $event]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => ['code' => 'match_elo_failed', 'message' => 'Could not load match ELO.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
