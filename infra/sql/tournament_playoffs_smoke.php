<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\TournamentPlayoffRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\PlayoffReconciliationService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

if (PHP_SAPI !== 'cli') { exit(2); }
$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';
$config = Config::load($root . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();

$assert = static function (bool $condition, string $message): void {
    if (!$condition) { throw new RuntimeException($message); }
};

$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$ids = ['club'=>0,'season'=>0,'tournament'=>0];
$players = [];
$registrations = [];
$groups = [];

try {
    $clubName = 'Playoff Smoke ' . $suffix;
    $clubSlug = 'playoff-smoke-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $seasonName = 'Playoff Season ' . $suffix;
    $starts = date('Y-m-d');
    $ends = date('Y-m-d', strtotime('+1 month'));
    $active = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$sseasons` (club_id, name, starts_on, ends_on, is_active) VALUES (?, ?, ?, ?, ?)',
        $prefix
    ));
    $stmt->bind_param('isssi', $ids['club'], $seasonName, $starts, $ends, $active);
    $stmt->execute();
    $ids['season'] = (int) $stmt->insert_id;
    $stmt->close();

    $tournamentName = 'Playoff Tournament ' . $suffix;
    $tournamentSlug = 'playoff-tournament-' . $suffix;
    $status = 'completed'; // group stage may already have completed the operational tournament lifecycle
    $startAt = date('Y-m-d H:i:s', strtotime('-2 hours'));
    $endAt = date('Y-m-d H:i:s');
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$stournaments`
         (club_id, season_id, name, slug, provider_system, status, start_at, end_at)
         VALUES (?, ?, ?, ?, "local", ?, ?, ?)',
        $prefix
    ));
    $stmt->bind_param('iisssss', $ids['club'], $ids['season'], $tournamentName, $tournamentSlug, $status, $startAt, $endAt);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    // Three groups with three players each. Rank 1 beats ranks 2 and 3;
    // rank 2 beats rank 3, giving an unambiguous 2-1-0 win table.
    $globalSeed = 1;
    foreach (['A', 'B', 'C'] as $groupIndex => $groupName) {
        $drawMode = 'elo_snake';
        $drawSeed = 20260825;
        $sortOrder = $groupIndex + 1;
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$stournament_groups` (tournament_id, name, sort_order, draw_mode, draw_seed)
             VALUES (?, ?, ?, ?, ?)',
            $prefix
        ));
        $stmt->bind_param('isisi', $ids['tournament'], $groupName, $sortOrder, $drawMode, $drawSeed);
        $stmt->execute();
        $groupId = (int) $stmt->insert_id;
        $stmt->close();
        $groups[$groupName] = $groupId;

        for ($rank = 1; $rank <= 3; $rank++) {
            $name = sprintf('Playoff %s%d %s', $groupName, $rank, $suffix);
            $stmt = $db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id, display_name) VALUES (?, ?)', $prefix));
            $stmt->bind_param('is', $ids['club'], $name);
            $stmt->execute();
            $playerId = (int) $stmt->insert_id;
            $stmt->close();
            $key = $groupName . $rank;
            $players[$key] = $playerId;

            $registrationStatus = 'checked_in';
            $source = 'smoke';
            $seedRating = 1200.0 - ($globalSeed * 10);
            $ratingSource = 'smoke';
            $stmt = $db->prepare(sprintf(
                'INSERT INTO `%1$stournament_players`
                 (tournament_id, player_id, seed, seed_rating, seed_rating_source, status, registration_source)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                $prefix
            ));
            $stmt->bind_param('iiidsss', $ids['tournament'], $playerId, $globalSeed, $seedRating, $ratingSource, $registrationStatus, $source);
            $stmt->execute();
            $registrationId = (int) $stmt->insert_id;
            $stmt->close();
            $registrations[$key] = $registrationId;

            $position = $rank;
            $stmt = $db->prepare(sprintf(
                'INSERT INTO `%1$stournament_group_players`
                 (group_id, tournament_player_id, position, seed_number, seed_rating, seed_rating_source)
                 VALUES (?, ?, ?, ?, ?, ?)',
                $prefix
            ));
            $stmt->bind_param('iiiids', $groupId, $registrationId, $position, $globalSeed, $seedRating, $ratingSource);
            $stmt->execute();
            $stmt->close();
            $globalSeed++;
        }
    }

    $createCompletedGroupMatch = static function (
        mysqli $db,
        string $prefix,
        int $tournamentId,
        int $groupId,
        string $groupName,
        int $round,
        int $a,
        int $b,
        int $winner
    ): int {
        $roundLabel = $groupName . ' · Runde ' . $round;
        $bracketLabel = $groupName;
        $status = 'completed';
        $finished = date('Y-m-d H:i:s', strtotime('-30 minutes +' . $round . ' minutes'));
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$smatches`
             (tournament_id, tournament_group_id, round_label, round_number, bracket_label, status,
              best_of_legs, legs_to_win, player_a_id, player_b_id, winner_player_id, starts_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)',
            $prefix
        ));
        $stmt->bind_param('iisissiiiss', $tournamentId, $groupId, $roundLabel, $round, $bracketLabel, $status, $a, $b, $winner, $finished, $finished);
        $stmt->execute();
        $matchId = (int) $stmt->insert_id;
        $stmt->close();

        $legStatus = 'completed';
        $stmt = $db->prepare(sprintf(
            'INSERT INTO `%1$slegs`
             (match_id, leg_number, starting_player_id, winner_player_id, status, start_score, finished_at)
             VALUES (?, 1, ?, ?, ?, 501, ?)',
            $prefix
        ));
        $stmt->bind_param('iiiss', $matchId, $a, $winner, $legStatus, $finished);
        $stmt->execute();
        $stmt->close();
        return $matchId;
    };

    foreach (['A', 'B', 'C'] as $groupName) {
        $groupId = $groups[$groupName];
        $one = $players[$groupName . '1'];
        $two = $players[$groupName . '2'];
        $three = $players[$groupName . '3'];
        $createCompletedGroupMatch($db, $prefix, $ids['tournament'], $groupId, $groupName, 1, $one, $two, $one);
        $createCompletedGroupMatch($db, $prefix, $ids['tournament'], $groupId, $groupName, 2, $one, $three, $one);
        $createCompletedGroupMatch($db, $prefix, $ids['tournament'], $groupId, $groupName, 3, $two, $three, $two);
    }

    $playoffs = new TournamentPlayoffRepository($database);
    $generated = $playoffs->generateFromGroups($ids['tournament'], 2, 3);
    $assert((int) ($generated['playoff']['bracket_size'] ?? 0) === 8, 'Six qualifiers should create an 8-slot bracket.');
    $assert(count($generated['entries'] ?? []) === 6, 'Expected six playoff entries.');
    $assert((string) ($generated['tournament']['status'] ?? '') === 'in_progress', 'Generating playoffs should reopen tournament lifecycle.');

    $round1 = $generated['rounds'][0]['nodes'] ?? [];
    $byeCount = count(array_filter($round1, static fn (array $node): bool => (string) ($node['status'] ?? '') === 'bye'));
    $pendingCount = count(array_filter($round1, static fn (array $node): bool => (string) ($node['status'] ?? '') === 'pending'));
    $assert($byeCount === 2, 'Expected two first-round byes for a six-player bracket.');
    $assert($pendingCount === 2, 'Expected two real first-round matches for a six-player bracket.');

    $entryGroupByPlayer = [];
    foreach ($generated['entries'] as $entry) {
        $entryGroupByPlayer[(int) $entry['player_id']] = (int) $entry['source_group_id'];
    }
    foreach ($round1 as $node) {
        if ($node['player_a_id'] === null || $node['player_b_id'] === null) { continue; }
        $groupA = $entryGroupByPlayer[(int) $node['player_a_id']] ?? 0;
        $groupB = $entryGroupByPlayer[(int) $node['player_b_id']] ?? 0;
        $assert($groupA !== $groupB, 'A same-group rematch remained in the first playoff round.');
    }

    $nonQualifierIds = [$players['A3'], $players['B3'], $players['C3']];
    foreach ($nonQualifierIds as $playerId) {
        $row = $db->query(sprintf(
            'SELECT status FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id=%3$d',
            $prefix,
            $ids['tournament'],
            $playerId
        ))->fetch_assoc();
        $assert(($row['status'] ?? '') === 'eliminated', 'A non-qualifier was not marked eliminated.');
    }

    $complete = static function (mysqli $db, string $prefix, int $matchId, int $winner): void {
        $stmt = $db->prepare(sprintf(
            'UPDATE `%1$smatches` SET status="completed", winner_player_id=?, finished_at=NOW() WHERE id=?',
            $prefix
        ));
        $stmt->bind_param('ii', $winner, $matchId);
        $stmt->execute();
        $stmt->close();
    };

    // Resolve the two real quarterfinals. Their winners plus the two bye winners
    // must materialize exactly two semifinals.
    foreach (array_values(array_filter($round1, static fn (array $node): bool => $node['match_id'] !== null)) as $node) {
        $winner = (int) $node['player_a_id'];
        $complete($db, $prefix, (int) $node['match_id'], $winner);
        $playoffs->reconcileTournament($ids['tournament']);
    }
    $afterQuarterfinals = $playoffs->getBracket($ids['tournament']);
    $semis = $afterQuarterfinals['rounds'][1]['nodes'] ?? [];
    $assert(count($semis) === 2, 'Expected two semifinal nodes.');
    foreach ($semis as $semi) {
        $assert($semi['match_id'] !== null && (string) $semi['status'] === 'pending', 'A semifinal was not materialized as a pending canonical match.');
    }

    // Resolve both semifinals; after the second one the final should exist.
    foreach ($semis as $semi) {
        $winner = (int) $semi['player_a_id'];
        $complete($db, $prefix, (int) $semi['match_id'], $winner);
        $playoffs->reconcileTournament($ids['tournament']);
    }
    $afterSemis = $playoffs->getBracket($ids['tournament']);
    $final = $afterSemis['rounds'][2]['nodes'][0] ?? null;
    $assert(is_array($final) && $final['match_id'] !== null, 'Final was not materialized after both semifinals completed.');
    $assert((string) $final['status'] === 'pending', 'New final should enter the ordinary pending match queue.');

    // Undo of a semifinal remains safe while its final is still pending and
    // unassigned. The final must disappear and the semifinal loser must return.
    $semiToUndo = $afterSemis['rounds'][1]['nodes'][1];
    $semiMatchId = (int) $semiToUndo['match_id'];
    $playoffs->assertUndoAllowedForMatch($semiMatchId);
    $db->query(sprintf(
        'UPDATE `%1$smatches` SET status="in_progress", winner_player_id=NULL, finished_at=NULL WHERE id=%2$d',
        $prefix,
        $semiMatchId
    ));
    $reconciliation = new PlayoffReconciliationService($database);
    $reconciliation->afterMutation($semiMatchId, true);
    $afterUndo = $playoffs->getBracket($ids['tournament']);
    $finalAfterUndo = $afterUndo['rounds'][2]['nodes'][0] ?? null;
    $assert(is_array($finalAfterUndo) && $finalAfterUndo['match_id'] === null, 'Pending final was not removed after semifinal undo.');
    foreach ([(int) $semiToUndo['player_a_id'], (int) $semiToUndo['player_b_id']] as $playerId) {
        $row = $db->query(sprintf(
            'SELECT status FROM `%1$stournament_players` WHERE tournament_id=%2$d AND player_id=%3$d',
            $prefix,
            $ids['tournament'],
            $playerId
        ))->fetch_assoc();
        $assert(($row['status'] ?? '') === 'checked_in', 'Reopened semifinal participant was not restored to checked_in.');
    }

    // Complete the reopened semifinal again; the final must be recreated.
    $winner = (int) $semiToUndo['player_a_id'];
    $complete($db, $prefix, $semiMatchId, $winner);
    $playoffs->reconcileTournament($ids['tournament']);
    $recreated = $playoffs->getBracket($ids['tournament']);
    $final = $recreated['rounds'][2]['nodes'][0] ?? null;
    $assert(is_array($final) && $final['match_id'] !== null, 'Final was not recreated after semifinal result returned.');
    $finalMatchId = (int) $final['match_id'];

    // Once the final is called up, undoing its semifinal is intentionally blocked.
    $db->query(sprintf('UPDATE `%1$smatches` SET status="assigned", kiosk_id=NULL WHERE id=%2$d', $prefix, $finalMatchId));
    $blocked = false;
    try {
        $playoffs->assertUndoAllowedForMatch($semiMatchId);
    } catch (ValidationException $error) {
        $blocked = $error->errorCode() === 'playoff_downstream_started';
    }
    $assert($blocked, 'Semifinal undo was not blocked after the final had been called up.');

    // Return final to pending for this smoke, complete it, and verify champion/lifecycle.
    $db->query(sprintf('UPDATE `%1$smatches` SET status="pending", kiosk_id=NULL WHERE id=%2$d', $prefix, $finalMatchId));
    $finalWinner = (int) $final['player_a_id'];
    $complete($db, $prefix, $finalMatchId, $finalWinner);
    $finished = $playoffs->reconcileTournament($ids['tournament']);
    $assert((string) ($finished['playoff']['status'] ?? '') === 'completed', 'Playoff did not complete after the final.');
    $assert((int) ($finished['playoff']['champion_player_id'] ?? 0) === $finalWinner, 'Wrong tournament champion recorded.');
    $assert((string) ($finished['tournament']['status'] ?? '') === 'completed', 'Tournament did not complete with the playoff final.');

    echo "Tournament playoff smoke OK\n";
} finally {
    if ($ids['tournament'] > 0) {
        // Remove bracket references before deleting canonical matches/groups.
        $db->query(sprintf('DELETE FROM `%1$stournament_playoffs` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
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
        $db->query(sprintf('DELETE FROM `%1$stournament_player_breaks` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_players` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=%2$d', $prefix, $ids['tournament']));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=%2$d', $prefix, $ids['tournament']));
    }
    foreach ($players as $playerId) {
        if ($playerId > 0) { $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=%2$d', $prefix, $playerId)); }
    }
    if ($ids['season'] > 0) { $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=%2$d', $prefix, $ids['season'])); }
    if ($ids['club'] > 0) { $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=%2$d', $prefix, $ids['club'])); }
}
