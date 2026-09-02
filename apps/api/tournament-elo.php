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

$tournamentId = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if (!$tournamentId) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => ['code' => 'tournament_id_required', 'message' => 'tournament_id is required.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $database = new Database(Config::load(__DIR__));
    $connection = $database->connection();
    $prefix = $database->tablePrefix();

    $tournamentStmt = $connection->prepare(sprintf(
        'SELECT id,name,status,start_at,end_at,season_id FROM `%1$stournaments` WHERE id=? LIMIT 1',
        $prefix
    ));
    $tournamentStmt->bind_param('i', $tournamentId);
    $tournamentStmt->execute();
    $tournament = $tournamentStmt->get_result()->fetch_assoc() ?: null;
    $tournamentStmt->close();
    if ($tournament === null) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => ['code' => 'tournament_not_found', 'message' => 'Tournament was not found.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    $snapshotStmt = $connection->prepare(sprintf(
        'SELECT s.player_id,p.display_name,s.elo_before,s.elo_after,s.matches_before,s.matches_after,
                s.captured_start_at,s.captured_end_at,
                COALESCE(ecr.rating,s.elo_after,s.elo_before) AS current_rating
         FROM `%1$stournament_elo_snapshots` s
         INNER JOIN `%1$splayers` p ON p.id=s.player_id
         LEFT JOIN `%1$selo_current_ratings` ecr ON ecr.season_id=s.season_id AND ecr.player_id=s.player_id
         WHERE s.tournament_id=?
         ORDER BY p.display_name ASC,p.id ASC',
        $prefix
    ));
    $snapshotStmt->bind_param('i', $tournamentId);
    $snapshotStmt->execute();
    $snapshots = $snapshotStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $snapshotStmt->close();

    $eventStmt = $connection->prepare(sprintf(
        'SELECT e.match_id,e.player_a_id,e.player_b_id,e.rating_a_before,e.rating_b_before,
                e.rating_a_after,e.rating_b_after,e.delta_a,e.delta_b,
                m.winner_player_id,m.round_label,m.round_number,m.bracket_label,m.finished_at,
                pa.display_name AS player_a_name,pb.display_name AS player_b_name
         FROM `%1$selo_match_events` e
         INNER JOIN `%1$smatches` m ON m.id=e.match_id
         INNER JOIN `%1$splayers` pa ON pa.id=e.player_a_id
         INNER JOIN `%1$splayers` pb ON pb.id=e.player_b_id
         WHERE e.tournament_id=? AND e.status="applied"
         ORDER BY COALESCE(m.finished_at,m.starts_at,m.created_at,e.applied_at) ASC,m.id ASC',
        $prefix
    ));
    $eventStmt->bind_param('i', $tournamentId);
    $eventStmt->execute();
    $events = $eventStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $eventStmt->close();

    $matchesByPlayer = [];
    foreach ($events as $event) {
        foreach (['a', 'b'] as $side) {
            $playerId = (int) $event['player_' . $side . '_id'];
            $opponentSide = $side === 'a' ? 'b' : 'a';
            $winnerId = $event['winner_player_id'] !== null ? (int) $event['winner_player_id'] : null;
            $matchesByPlayer[$playerId][] = [
                'match_id' => (int) $event['match_id'],
                'opponent_name' => (string) $event['player_' . $opponentSide . '_name'],
                'result' => $winnerId === null ? 'draw' : ($winnerId === $playerId ? 'win' : 'loss'),
                'rating_before' => (float) $event['rating_' . $side . '_before'],
                'rating_after' => (float) $event['rating_' . $side . '_after'],
                'delta' => (float) $event['delta_' . $side],
                'round_label' => $event['round_label'],
                'round_number' => $event['round_number'] !== null ? (int) $event['round_number'] : null,
                'bracket_label' => $event['bracket_label'],
                'finished_at' => $event['finished_at'],
            ];
        }
    }

    $completed = (string) $tournament['status'] === 'completed';
    $players = [];
    foreach ($snapshots as $row) {
        $before = (float) $row['elo_before'];
        $after = $row['elo_after'] !== null ? (float) $row['elo_after'] : null;
        $current = $completed && $after !== null ? $after : (float) $row['current_rating'];
        $playerId = (int) $row['player_id'];
        $players[] = [
            'player_id' => $playerId,
            'display_name' => (string) $row['display_name'],
            'rating_before' => $before,
            'rating_after' => $after,
            'current_rating' => $current,
            'delta' => $current - $before,
            'matches_before' => (int) $row['matches_before'],
            'matches_after' => $row['matches_after'] !== null ? (int) $row['matches_after'] : null,
            'matches' => $matchesByPlayer[$playerId] ?? [],
        ];
    }
    usort($players, static function (array $a, array $b): int {
        $rating = ((float) $b['current_rating']) <=> ((float) $a['current_rating']);
        return $rating !== 0 ? $rating : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
    });

    echo json_encode([
        'ok' => true,
        'data' => [
            'tournament' => [
                'id' => (int) $tournament['id'],
                'season_id' => $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null,
                'name' => (string) $tournament['name'],
                'status' => (string) $tournament['status'],
                'start_at' => $tournament['start_at'],
                'end_at' => $tournament['end_at'],
            ],
            'players' => $players,
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => ['code' => 'tournament_elo_failed', 'message' => 'Could not load tournament ELO.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
