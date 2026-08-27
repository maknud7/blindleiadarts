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

$playerId = filter_input(INPUT_GET, 'player_id', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if (!$playerId) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => ['code' => 'player_id_required', 'message' => 'player_id is required.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

try {
    $database = new Database(Config::load(__DIR__));
    $connection = $database->connection();
    $prefix = $database->tablePrefix();

    $playerStmt = $connection->prepare(sprintf(
        'SELECT id,club_id,member_id,display_name FROM `%1$splayers` WHERE id=? LIMIT 1',
        $prefix
    ));
    $playerStmt->bind_param('i', $playerId);
    $playerStmt->execute();
    $player = $playerStmt->get_result()->fetch_assoc() ?: null;
    $playerStmt->close();
    if ($player === null) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => ['code' => 'player_not_found', 'message' => 'Player was not found.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    $clubId = (int) $player['club_id'];
    $displayName = trim((string) $player['display_name']);
    $memberId = $player['member_id'] !== null ? (int) $player['member_id'] : null;
    $aliasStmt = $connection->prepare(sprintf(
        'SELECT id,member_id FROM `%1$splayers`
         WHERE club_id=? AND is_active=1 AND LOWER(TRIM(display_name))=LOWER(TRIM(?))
         ORDER BY id ASC',
        $prefix
    ));
    $aliasStmt->bind_param('is', $clubId, $displayName);
    $aliasStmt->execute();
    $aliasRows = $aliasStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $aliasStmt->close();

    $knownMembers = [];
    foreach ($aliasRows as $row) {
        if ($row['member_id'] !== null && (int) $row['member_id'] > 0) {
            $knownMembers[(int) $row['member_id']] = true;
        }
    }
    $singleKnownMember = count($knownMembers) === 1 ? (int) array_key_first($knownMembers) : null;

    $aliasIds = [];
    foreach ($aliasRows as $row) {
        $rowMemberId = $row['member_id'] !== null ? (int) $row['member_id'] : null;
        $include = false;
        if ($memberId !== null) {
            $include = $rowMemberId === null || $rowMemberId === $memberId;
        } elseif ($singleKnownMember !== null) {
            $include = $rowMemberId === null || $rowMemberId === $singleKnownMember;
        } elseif ($knownMembers === []) {
            $include = $rowMemberId === null;
        } else {
            // Ambiguous same-name group with several known members: never guess.
            $include = $rowMemberId === null;
        }
        if ($include) $aliasIds[] = (int) $row['id'];
    }
    if (!in_array((int) $player['id'], $aliasIds, true)) $aliasIds[] = (int) $player['id'];
    $aliasIds = array_values(array_unique(array_filter($aliasIds, static fn (int $id): bool => $id > 0)));
    sort($aliasIds);
    $ids = implode(',', array_map('intval', $aliasIds));

    $sql = sprintf(
        'SELECT e.id AS event_id,e.match_id,e.tournament_id,e.season_id,e.player_a_id,e.player_b_id,
                e.rating_a_before,e.rating_b_before,e.rating_a_after,e.rating_b_after,e.delta_a,e.delta_b,
                e.matches_before_a,e.matches_before_b,e.k_a,e.k_b,e.applied_at,
                m.winner_player_id,m.round_label,m.round_number,m.bracket_label,m.finished_at,m.tournament_group_id,
                t.name AS tournament_name,t.start_at,
                pa.display_name AS player_a_name,pb.display_name AS player_b_name,
                CASE
                    WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,""))="group" THEN 0
                    WHEN pn.id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,"")) IN ("single_elimination","playoff","knockout") THEN 2
                    ELSE 1
                END AS phase_order,
                CASE
                    WHEN m.tournament_group_id IS NOT NULL OR LOWER(COALESCE(m.bracket_label,""))="group"
                        THEN COALESCE(m.round_number,32767)
                    WHEN pn.id IS NOT NULL
                        THEN COALESCE(pn.round_number,m.round_number,32767)
                    ELSE COALESCE(m.round_number,32767)
                END AS logical_round,
                COALESCE(tg.sort_order,0) AS group_order,
                COALESCE(pn.position,0) AS playoff_position,
                COALESCE(m.finished_at,m.starts_at,t.start_at,m.created_at,e.applied_at) AS occurred_at
         FROM `%1$selo_match_events` e
         INNER JOIN `%1$smatches` m ON m.id=e.match_id
         INNER JOIN `%1$stournaments` t ON t.id=e.tournament_id
         INNER JOIN `%1$splayers` pa ON pa.id=e.player_a_id
         INNER JOIN `%1$splayers` pb ON pb.id=e.player_b_id
         LEFT JOIN `%1$stournament_groups` tg ON tg.id=m.tournament_group_id
         LEFT JOIN `%1$stournament_playoff_nodes` pn ON pn.match_id=m.id
         WHERE e.status="applied" AND (e.player_a_id IN (%2$s) OR e.player_b_id IN (%2$s))
         ORDER BY COALESCE(t.start_at,m.created_at,e.applied_at) ASC,
                  t.id ASC,
                  phase_order ASC,
                  logical_round ASC,
                  group_order ASC,
                  playoff_position ASC,
                  occurred_at ASC,
                  m.id ASC,
                  e.id ASC',
        $prefix,
        $ids
    );
    $rows = $connection->query($sql)->fetch_all(MYSQLI_ASSOC);
    $aliasLookup = array_fill_keys($aliasIds, true);
    $items = [];
    $previousAfter = null;
    $previousMatchesAfter = null;
    $continuityOk = true;
    $startsAt1000 = true;

    foreach ($rows as $row) {
        $isA = isset($aliasLookup[(int) $row['player_a_id']]);
        $before = (float) ($isA ? $row['rating_a_before'] : $row['rating_b_before']);
        $after = (float) ($isA ? $row['rating_a_after'] : $row['rating_b_after']);
        $delta = (float) ($isA ? $row['delta_a'] : $row['delta_b']);
        $matchesBefore = (int) ($isA ? $row['matches_before_a'] : $row['matches_before_b']);
        $opponentName = (string) ($isA ? $row['player_b_name'] : $row['player_a_name']);
        $winnerId = $row['winner_player_id'] !== null ? (int) $row['winner_player_id'] : null;
        $result = $winnerId === null ? 'draw' : (isset($aliasLookup[$winnerId]) ? 'win' : 'loss');
        $phaseOrder = (int) $row['phase_order'];
        $phase = $phaseOrder === 0 ? 'group' : ($phaseOrder === 2 ? 'playoff' : 'match');

        if ($previousAfter === null) {
            if (abs($before - 1000.0) > 0.0001 || $matchesBefore !== 0) $startsAt1000 = false;
        } elseif (abs($before - $previousAfter) > 0.0001 || $matchesBefore !== $previousMatchesAfter) {
            $continuityOk = false;
        }
        $previousAfter = $after;
        $previousMatchesAfter = $matchesBefore + 1;

        $items[] = [
            'event_id' => (int) $row['event_id'],
            'match_id' => (int) $row['match_id'],
            'tournament_id' => (int) $row['tournament_id'],
            'season_id' => $row['season_id'] !== null ? (int) $row['season_id'] : null,
            'rating_before' => $before,
            'rating_after' => $after,
            'delta' => $delta,
            'matches_before' => $matchesBefore,
            'matches_after' => $matchesBefore + 1,
            'opponent_name' => $opponentName,
            'result' => $result,
            'round_label' => $row['round_label'],
            'round_number' => $row['round_number'] !== null ? (int) $row['round_number'] : null,
            'bracket_label' => $row['bracket_label'],
            'phase' => $phase,
            'phase_order' => $phaseOrder,
            'logical_round' => (int) $row['logical_round'],
            'tournament_name' => $row['tournament_name'],
            'finished_at' => $row['finished_at'],
            'start_at' => $row['start_at'],
            'occurred_at' => $row['occurred_at'],
            'applied_at' => $row['applied_at'],
        ];
    }

    echo json_encode([
        'ok' => true,
        'data' => [
            'player_id' => (int) $player['id'],
            'alias_player_ids' => $aliasIds,
            'starts_at_1000' => $startsAt1000,
            'continuity_ok' => $continuityOk,
            'chronology' => 'round_robin_then_playoff',
            'items' => $items,
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => ['code' => 'player_elo_history_failed', 'message' => 'Could not load player ELO history.']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
