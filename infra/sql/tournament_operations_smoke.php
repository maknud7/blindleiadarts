<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\TournamentOperationsRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') {
    exit(2);
}

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';

$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$ids = [
    'club' => 0, 'season' => 0, 'tournament' => 0,
    'board_a' => 0, 'board_b' => 0,
    'player_a' => 0, 'player_b' => 0, 'player_c' => 0, 'player_d' => 0,
    'match_1' => 0, 'match_2' => 0, 'match_3' => 0,
];

try {
    $clubName = 'Operations Smoke ' . $suffix;
    $clubSlug = 'operations-smoke-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $seasonName = 'Operations Season ' . $suffix;
    $startsOn = date('Y-m-d');
    $endsOn = date('Y-m-d', strtotime('+1 month'));
    $active = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$sseasons` (club_id, name, starts_on, ends_on, is_active) VALUES (?, ?, ?, ?, ?)',
        $prefix
    ));
    $stmt->bind_param('isssi', $ids['club'], $seasonName, $startsOn, $endsOn, $active);
    $stmt->execute();
    $ids['season'] = (int) $stmt->insert_id;
    $stmt->close();

    $tournamentName = 'Operations Tournament ' . $suffix;
    $tournamentSlug = 'operations-tournament-' . $suffix;
    $status = 'ready';
    $startAt = date('Y-m-d H:i:s');
    $autoAssign = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$stournaments`
         (club_id, season_id, name, slug, provider_system, status, start_at, auto_assign_enabled)
         VALUES (?, ?, ?, ?, "local", ?, ?, ?)',
        $prefix
    ));
    $stmt->bind_param('iissssi', $ids['club'], $ids['season'], $tournamentName, $tournamentSlug, $status, $startAt, $autoAssign);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    $playerSql = sprintf('INSERT INTO `%1$splayers` (club_id, display_name) VALUES (?, ?)', $prefix);
    foreach (['A', 'B', 'C', 'D'] as $label) {
        $name = 'Ops ' . $label . ' ' . $suffix;
        $stmt = $db->prepare($playerSql);
        $stmt->bind_param('is', $ids['club'], $name);
        $stmt->execute();
        $ids['player_' . strtolower($label)] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $registrationSql = sprintf(
        'INSERT INTO `%1$stournament_players` (tournament_id, player_id, status, registration_source)
         VALUES (?, ?, "checked_in", "smoke")',
        $prefix
    );
    foreach (['player_a', 'player_b', 'player_c', 'player_d'] as $key) {
        $stmt = $db->prepare($registrationSql);
        $stmt->bind_param('ii', $ids['tournament'], $ids[$key]);
        $stmt->execute();
        $stmt->close();
    }

    $boardSql = sprintf(
        'INSERT INTO `%1$skiosks` (club_id, code, name, board_number, is_active) VALUES (?, ?, ?, ?, 1)',
        $prefix
    );
    foreach ([['board_a', 901], ['board_b', 902]] as [$key, $number]) {
        $code = 'OPS-' . strtoupper(substr($suffix, 0, 6)) . '-' . $number;
        $name = 'Ops Board ' . $number;
        $stmt = $db->prepare($boardSql);
        $stmt->bind_param('issi', $ids['club'], $code, $name, $number);
        $stmt->execute();
        $ids[$key] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $linkSql = sprintf(
        'INSERT INTO `%1$stournament_kiosks` (tournament_id, kiosk_id, sort_order) VALUES (?, ?, ?)',
        $prefix
    );
    foreach ([['board_a', 1], ['board_b', 2]] as [$key, $order]) {
        $stmt = $db->prepare($linkSql);
        $stmt->bind_param('iii', $ids['tournament'], $ids[$key], $order);
        $stmt->execute();
        $stmt->close();
    }

    $matchSql = sprintf(
        'INSERT INTO `%1$smatches`
         (tournament_id, round_label, round_number, status, best_of_legs, legs_to_win, player_a_id, player_b_id)
         VALUES (?, ?, ?, "pending", 1, 1, ?, ?)',
        $prefix
    );
    $matches = [
        ['match_1', 'Runde 1', 1, 'player_a', 'player_b'],
        ['match_2', 'Runde 1', 1, 'player_c', 'player_d'],
        ['match_3', 'Runde 2', 2, 'player_a', 'player_c'],
    ];
    foreach ($matches as [$matchKey, $round, $roundNo, $aKey, $bKey]) {
        $stmt = $db->prepare($matchSql);
        $stmt->bind_param('isiii', $ids['tournament'], $round, $roundNo, $ids[$aKey], $ids[$bKey]);
        $stmt->execute();
        $ids[$matchKey] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $ops = new TournamentOperationsRepository($database);
    $first = $ops->reconcileTournament($ids['tournament']);
    $assert((int) ($first['assignment']['assigned_count'] ?? 0) === 2, 'Expected two matches to fill two boards.');
    $assert((string) ($first['tournament']['status'] ?? '') === 'in_progress', 'Tournament did not enter in_progress.');
    $assert((int) ($first['progress']['assigned'] ?? 0) === 2, 'Two matches were not assigned.');
    $assert((int) ($first['progress']['pending'] ?? 0) === 1, 'Third match should remain pending.');

    $matchStateSql = sprintf('SELECT kiosk_id, status FROM `%1$smatches` WHERE id=?', $prefix);
    $stmt = $db->prepare($matchStateSql);
    $stmt->bind_param('i', $ids['match_1']);
    $stmt->execute();
    $match1 = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $stmt = $db->prepare($matchStateSql);
    $stmt->bind_param('i', $ids['match_2']);
    $stmt->execute();
    $match2 = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert($match1['kiosk_id'] !== null && $match2['kiosk_id'] !== null, 'Initial matches were not assigned to boards.');
    $boardForMatch1 = (int) $match1['kiosk_id'];
    $boardForMatch2 = (int) $match2['kiosk_id'];

    $completeSql = sprintf(
        'UPDATE `%1$smatches` SET status="completed", winner_player_id=?, finished_at=NOW() WHERE id=?',
        $prefix
    );
    $stmt = $db->prepare($completeSql);
    $stmt->bind_param('ii', $ids['player_a'], $ids['match_1']);
    $stmt->execute();
    $stmt->close();

    $blocked = $ops->assignNextToKiosk($boardForMatch1);
    $assert(($blocked['assigned'] ?? true) === false, 'Round 2 was assigned while player C was still busy.');
    $assert(($blocked['reason'] ?? '') === 'no_ready_match', 'Expected no_ready_match while next opponent was busy.');

    $postMatch = $ops->kioskPostMatch($boardForMatch1);
    $assert((int) ($postMatch['last_completed_match']['id'] ?? 0) === $ids['match_1'], 'Post-match result was not available before next assignment.');

    $stmt = $db->prepare($completeSql);
    $stmt->bind_param('ii', $ids['player_c'], $ids['match_2']);
    $stmt->execute();
    $stmt->close();

    $next = $ops->assignNextToKiosk($boardForMatch1);
    $assert(($next['assigned'] ?? false) === true, 'Round 2 was not assigned after both players became available.');
    $assert((int) ($next['match']['id'] ?? 0) === $ids['match_3'], 'Wrong match was selected from the queue.');

    $stmt = $db->prepare($completeSql);
    $stmt->bind_param('ii', $ids['player_a'], $ids['match_3']);
    $stmt->execute();
    $stmt->close();

    $finish = $ops->assignNextToKiosk($boardForMatch1);
    $assert(($finish['assigned'] ?? true) === false, 'Unexpected match assigned after queue was exhausted.');
    $final = $ops->snapshot($ids['tournament']);
    $assert((string) ($final['tournament']['status'] ?? '') === 'completed', 'Tournament did not complete when queue was exhausted.');
    $assert((int) ($final['progress']['completed'] ?? 0) === 3, 'Completed match count is incorrect.');
    $assert((int) ($final['progress']['pending'] ?? -1) === 0, 'Pending match count should be zero.');

    $disabled = $ops->updateAutoAssignEnabled($ids['tournament'], false);
    $assert((int) ($disabled['tournament']['auto_assign_enabled'] ?? 1) === 0, 'Auto assignment setting did not persist.');

    echo "Tournament operations smoke OK\n";
} finally {
    if ($ids['tournament'] > 0) {
        foreach (['match_statistics', 'live_match_states', 'visits', 'legs'] as $table) {
            $db->query(sprintf(
                'DELETE target FROM `%1$s%2$s` target INNER JOIN `%1$smatches` m ON m.id=target.match_id WHERE m.tournament_id=%3$d',
                $prefix,
                $table,
                $ids['tournament']
            ));
        }
        $db->query(sprintf('DELETE FROM `%1$smatches` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_group_players` WHERE group_id IN (SELECT id FROM `%1$stournament_groups` WHERE tournament_id=%2$d)', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_groups` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_kiosks` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d', $prefix, $ids['tournament']));
    }
    foreach (['board_a', 'board_b'] as $key) {
        if ($ids[$key] > 0) {
            $db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id=%2$d', $prefix, $ids[$key]));
        }
    }
    foreach (['player_a', 'player_b', 'player_c', 'player_d'] as $key) {
        if ($ids[$key] > 0) {
            $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d', $prefix, $ids[$key]));
        }
    }
    if ($ids['season'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d', $prefix, $ids['season']));
    }
    if ($ids['club'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $prefix, $ids['club']));
    }
}
