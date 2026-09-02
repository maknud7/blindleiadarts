<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\PlayerPortalRepository;
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

$playerId = filter_input(INPUT_GET, 'player_id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if (!$playerId) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => ['code' => 'player_id_required', 'message' => 'player_id is required.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $database = new Database(Config::load(__DIR__));
    $portal = new PlayerPortalRepository($database);
    $profile = $portal->getPlayerProfile((int) $playerId);
    if ($profile === null) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => ['code' => 'player_not_found', 'message' => 'Player was not found.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    $aliasIds = array_values(array_unique(array_filter(array_map(
        'intval',
        (array) ($profile['player']['alias_player_ids'] ?? [$playerId])
    ), static fn (int $id): bool => $id > 0)));
    if ($aliasIds === []) {
        $aliasIds = [(int) $playerId];
    }

    $connection = $database->connection();
    $prefix = $database->tablePrefix();
    $ids = implode(',', $aliasIds);
    $sql = sprintf(
        'SELECT s.tournament_id,s.season_id,s.player_id,s.elo_before,s.elo_after,
                s.matches_before,s.matches_after,s.captured_start_at,s.captured_end_at,
                t.name AS tournament_name,t.status AS tournament_status,t.start_at,t.end_at
         FROM `%1$stournament_elo_snapshots` s
         INNER JOIN `%1$stournaments` t ON t.id=s.tournament_id
         WHERE s.player_id IN (%2$s)
         ORDER BY COALESCE(t.start_at,s.captured_start_at) ASC,t.id ASC,s.player_id ASC',
        $prefix,
        $ids
    );
    $rows = $connection->query($sql)->fetch_all(MYSQLI_ASSOC);

    // Identity aliases can exist after historical imports. Collapse them into one
    // tournament boundary by using the earliest matches_before and latest
    // matches_after values, which correspond to the canonical ledger timeline.
    $grouped = [];
    foreach ($rows as $row) {
        $tournamentId = (int) $row['tournament_id'];
        $before = (float) $row['elo_before'];
        $after = $row['elo_after'] !== null ? (float) $row['elo_after'] : null;
        $matchesBefore = (int) $row['matches_before'];
        $matchesAfter = $row['matches_after'] !== null ? (int) $row['matches_after'] : null;
        if (!isset($grouped[$tournamentId])) {
            $grouped[$tournamentId] = [
                'tournament_id' => $tournamentId,
                'season_id' => (int) $row['season_id'],
                'tournament_name' => (string) $row['tournament_name'],
                'tournament_status' => (string) $row['tournament_status'],
                'start_at' => $row['start_at'] ?: $row['captured_start_at'],
                'end_at' => $row['end_at'] ?: $row['captured_end_at'],
                'rating_before' => $before,
                'rating_after' => $after,
                'matches_before' => $matchesBefore,
                'matches_after' => $matchesAfter,
                '_first_matches' => $matchesBefore,
                '_last_matches' => $matchesAfter ?? $matchesBefore,
            ];
            continue;
        }
        if ($matchesBefore < $grouped[$tournamentId]['_first_matches']) {
            $grouped[$tournamentId]['_first_matches'] = $matchesBefore;
            $grouped[$tournamentId]['matches_before'] = $matchesBefore;
            $grouped[$tournamentId]['rating_before'] = $before;
        }
        if ($matchesAfter !== null && $matchesAfter >= $grouped[$tournamentId]['_last_matches']) {
            $grouped[$tournamentId]['_last_matches'] = $matchesAfter;
            $grouped[$tournamentId]['matches_after'] = $matchesAfter;
            $grouped[$tournamentId]['rating_after'] = $after;
        }
    }

    $items = array_values($grouped);
    usort($items, static function (array $a, array $b): int {
        $date = strcmp((string) ($a['start_at'] ?? ''), (string) ($b['start_at'] ?? ''));
        return $date !== 0 ? $date : ((int) $a['tournament_id'] <=> (int) $b['tournament_id']);
    });
    foreach ($items as &$item) {
        unset($item['_first_matches'], $item['_last_matches']);
        $item['delta'] = $item['rating_after'] !== null
            ? (float) $item['rating_after'] - (float) $item['rating_before']
            : null;
        $item['tournament_matches'] = $item['matches_after'] !== null
            ? max(0, (int) $item['matches_after'] - (int) $item['matches_before'])
            : null;
        $item['completed'] = $item['rating_after'] !== null;
    }
    unset($item);

    echo json_encode([
        'ok' => true,
        'data' => [
            'player_id' => (int) $playerId,
            'alias_player_ids' => $aliasIds,
            'items' => $items,
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => ['code' => 'player_tournament_elo_failed', 'message' => 'Could not load tournament ELO history.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
