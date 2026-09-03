<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloLedgerService;
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
$close = static function (float $actual, float $expected, string $message) use ($assert): void {
    $assert(abs($actual - $expected) < 0.00001, $message . " Expected {$expected}, got {$actual}.");
};

$suffix = strtolower(substr(bin2hex(random_bytes(6)), 0, 12));
$memberSeed = random_int(10000000, 90000000);
$ids = [
    'club' => 0,
    'season' => 0,
    'tournament' => 0,
    'player_a' => 0,
    'player_b' => 0,
    'guest' => 0,
    'match_1' => 0,
    'match_2' => 0,
    'match_guest' => 0,
];

try {
    $clubName = 'ELO Smoke ' . $suffix;
    $clubSlug = 'elo-smoke-' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $prefix));
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $seasonName = 'ELO Smoke Season ' . $suffix;
    $startsOn = '2026-08-01';
    $endsOn = '2026-12-31';
    $active = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$sseasons` (club_id, name, starts_on, ends_on, is_active) VALUES (?, ?, ?, ?, ?)',
        $prefix
    ));
    $stmt->bind_param('isssi', $ids['club'], $seasonName, $startsOn, $endsOn, $active);
    $stmt->execute();
    $ids['season'] = (int) $stmt->insert_id;
    $stmt->close();

    $playerSql = sprintf('INSERT INTO `%1$splayers` (club_id, member_id, display_name) VALUES (?, ?, ?)', $prefix);
    foreach ([
        ['key' => 'player_a', 'member_id' => $memberSeed + 1, 'name' => 'ELO Smoke A ' . $suffix],
        ['key' => 'player_b', 'member_id' => $memberSeed + 2, 'name' => 'ELO Smoke B ' . $suffix],
    ] as $player) {
        $stmt = $db->prepare($playerSql);
        $memberId = (int) $player['member_id'];
        $name = (string) $player['name'];
        $stmt->bind_param('iis', $ids['club'], $memberId, $name);
        $stmt->execute();
        $ids[(string) $player['key']] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $guestName = 'ELO Smoke Guest ' . $suffix;
    $stmt = $db->prepare(sprintf('INSERT INTO `%1$splayers` (club_id, member_id, display_name) VALUES (?, NULL, ?)', $prefix));
    $stmt->bind_param('is', $ids['club'], $guestName);
    $stmt->execute();
    $ids['guest'] = (int) $stmt->insert_id;
    $stmt->close();

    $tournamentName = 'ELO Smoke Tournament ' . $suffix;
    $tournamentSlug = 'elo-smoke-tournament-' . $suffix;
    $startAt = '2026-08-25 18:30:00';
    $eloEnabled = 1;
    $stmt = $db->prepare(sprintf(
        'INSERT INTO `%1$stournaments`
         (club_id, season_id, name, slug, provider_system, status, start_at, elo_enabled)
         VALUES (?, ?, ?, ?, "local", "in_progress", ?, ?)',
        $prefix
    ));
    $stmt->bind_param('iisssi', $ids['club'], $ids['season'], $tournamentName, $tournamentSlug, $startAt, $eloEnabled);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    $matchSql = sprintf(
        'INSERT INTO `%1$smatches`
         (tournament_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id, winner_player_id, starts_at, finished_at)
         VALUES (?, "completed", 1, 1, ?, ?, ?, ?, ?)',
        $prefix
    );

    $start1 = '2026-08-25 18:31:00';
    $finish1 = '2026-08-25 18:35:00';
    $winner1 = $ids['player_a'];
    $stmt = $db->prepare($matchSql);
    $stmt->bind_param('iiiiss', $ids['tournament'], $ids['player_a'], $ids['player_b'], $winner1, $start1, $finish1);
    $stmt->execute();
    $ids['match_1'] = (int) $stmt->insert_id;
    $stmt->close();

    $ledger = new EloLedgerService($database);
    $ledger->applyCompletedMatch($ids['match_1']);

    $eventSql = sprintf('SELECT * FROM `%1$selo_match_events` WHERE match_id=?', $prefix);
    $stmt = $db->prepare($eventSql);
    $stmt->bind_param('i', $ids['match_1']);
    $stmt->execute();
    $event1 = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert(($event1['status'] ?? null) === 'applied', 'First ELO event was not applied.');
    $close((float) ($event1['rating_a_before'] ?? 0), 1000.0, 'First match A rating before is wrong.');
    $close((float) ($event1['rating_b_before'] ?? 0), 1000.0, 'First match B rating before is wrong.');
    $close((float) ($event1['rating_a_after'] ?? 0), 1012.5, 'First match A rating after is wrong.');
    $close((float) ($event1['rating_b_after'] ?? 0), 987.5, 'First match B rating after is wrong.');
    $assert((int) ($event1['matches_before_a'] ?? -1) === 0, 'First match A count before is wrong.');
    $assert((int) ($event1['matches_before_b'] ?? -1) === 0, 'First match B count before is wrong.');
    $close((float) ($event1['k_a'] ?? 0), 25.0, 'First match A K is wrong.');
    $close((float) ($event1['k_b'] ?? 0), 25.0, 'First match B K is wrong.');

    $ledger->applyCompletedMatch($ids['match_1']);
    $stmt = $db->prepare(sprintf('SELECT COUNT(*) AS c FROM `%1$selo_match_events` WHERE match_id=?', $prefix));
    $stmt->bind_param('i', $ids['match_1']);
    $stmt->execute();
    $assert((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 1, 'ELO apply was not idempotent.');
    $stmt->close();

    usleep(2000);
    $start2 = '2026-08-25 18:36:00';
    $finish2 = '2026-08-25 18:40:00';
    $winner2 = $ids['player_b'];
    $stmt = $db->prepare($matchSql);
    $stmt->bind_param('iiiiss', $ids['tournament'], $ids['player_a'], $ids['player_b'], $winner2, $start2, $finish2);
    $stmt->execute();
    $ids['match_2'] = (int) $stmt->insert_id;
    $stmt->close();
    $ledger->applyCompletedMatch($ids['match_2']);

    $stmt = $db->prepare($eventSql);
    $stmt->bind_param('i', $ids['match_2']);
    $stmt->execute();
    $event2BeforeReplay = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $close((float) ($event2BeforeReplay['rating_a_before'] ?? 0), 1012.5, 'Second match did not start from first match A rating.');
    $close((float) ($event2BeforeReplay['rating_b_before'] ?? 0), 987.5, 'Second match did not start from first match B rating.');
    $assert((int) ($event2BeforeReplay['matches_before_a'] ?? -1) === 1, 'Second match A count before is wrong.');
    $assert((int) ($event2BeforeReplay['matches_before_b'] ?? -1) === 1, 'Second match B count before is wrong.');

    $ledger->revertMatch($ids['match_1']);

    $stmt = $db->prepare($eventSql);
    $stmt->bind_param('i', $ids['match_1']);
    $stmt->execute();
    $event1After = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert(($event1After['status'] ?? null) === 'reverted', 'Earlier ELO event was not marked reverted.');

    $stmt = $db->prepare($eventSql);
    $stmt->bind_param('i', $ids['match_2']);
    $stmt->execute();
    $event2AfterReplay = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $close((float) ($event2AfterReplay['rating_a_before'] ?? 0), 1000.0, 'Replay did not reset later A rating before.');
    $close((float) ($event2AfterReplay['rating_b_before'] ?? 0), 1000.0, 'Replay did not reset later B rating before.');
    $close((float) ($event2AfterReplay['rating_a_after'] ?? 0), 987.5, 'Replay produced wrong A rating after.');
    $close((float) ($event2AfterReplay['rating_b_after'] ?? 0), 1012.5, 'Replay produced wrong B rating after.');
    $assert((int) ($event2AfterReplay['matches_before_a'] ?? -1) === 0, 'Replay did not reset A match count.');
    $assert((int) ($event2AfterReplay['matches_before_b'] ?? -1) === 0, 'Replay did not reset B match count.');

    // A guest has no member_id. The entire match must therefore be invisible to ELO,
    // including for the established member on the other side.
    $guestStart = '2026-08-25 18:41:00';
    $guestFinish = '2026-08-25 18:45:00';
    $guestWinner = $ids['player_a'];
    $stmt = $db->prepare($matchSql);
    $stmt->bind_param('iiiiss', $ids['tournament'], $ids['player_a'], $ids['guest'], $guestWinner, $guestStart, $guestFinish);
    $stmt->execute();
    $ids['match_guest'] = (int) $stmt->insert_id;
    $stmt->close();

    $ledger->applyCompletedMatch($ids['match_guest']);
    $stmt = $db->prepare(sprintf('SELECT COUNT(*) AS c FROM `%1$selo_match_events` WHERE match_id=?', $prefix));
    $stmt->bind_param('i', $ids['match_guest']);
    $stmt->execute();
    $assert((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 0, 'Guest match created an ELO event.');
    $stmt->close();

    // Simulate a stale event created by an older release, then prove deployment reconciliation
    // reverts it and replays the season without changing the member ratings.
    $legacySql = sprintf(
        'INSERT INTO `%1$selo_match_events`
         (match_id, tournament_id, season_id, club_id, player_a_id, player_b_id, winner_player_id,
          score_a, score_b, status, applied_at, reverted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0.0, "applied", CURRENT_TIMESTAMP(6), NULL)',
        $prefix
    );
    $stmt = $db->prepare($legacySql);
    $stmt->bind_param(
        'iiiiiii',
        $ids['match_guest'],
        $ids['tournament'],
        $ids['season'],
        $ids['club'],
        $ids['player_a'],
        $ids['guest'],
        $guestWinner
    );
    $stmt->execute();
    $stmt->close();

    $reconcile = $ledger->reconcileGuestMatches();
    $assert((int) $reconcile['reverted_events'] >= 1, 'Legacy guest ELO event was not reconciled.');
    $assert((int) $reconcile['rebuilt_seasons'] >= 1, 'Guest ELO reconciliation did not rebuild the season.');

    $stmt = $db->prepare($eventSql);
    $stmt->bind_param('i', $ids['match_guest']);
    $stmt->execute();
    $guestEvent = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert(($guestEvent['status'] ?? null) === 'reverted', 'Legacy guest event was not marked reverted.');

    $currentSql = sprintf(
        'SELECT player_id, rating, matches_played FROM `%1$selo_current_ratings` WHERE season_id=? ORDER BY player_id',
        $prefix
    );
    $stmt = $db->prepare($currentSql);
    $stmt->bind_param('i', $ids['season']);
    $stmt->execute();
    $currentRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    $assert(count($currentRows) === 2, 'Current ELO table should contain only the two member players.');
    $byPlayer = [];
    foreach ($currentRows as $row) {
        $byPlayer[(int) $row['player_id']] = $row;
    }
    $close((float) ($byPlayer[$ids['player_a']]['rating'] ?? 0), 987.5, 'Current A rating after guest reconciliation is wrong.');
    $close((float) ($byPlayer[$ids['player_b']]['rating'] ?? 0), 1012.5, 'Current B rating after guest reconciliation is wrong.');
    $assert((int) ($byPlayer[$ids['player_a']]['matches_played'] ?? -1) === 1, 'Current A ELO match count includes a guest match.');
    $assert((int) ($byPlayer[$ids['player_b']]['matches_played'] ?? -1) === 1, 'Current B ELO match count is wrong.');
    $assert(!isset($byPlayer[$ids['guest']]), 'Guest player appeared in current ELO ratings.');

    $snapshotSql = sprintf(
        'SELECT COUNT(*) AS c FROM `%1$sranking_snapshots`
         WHERE season_id=? AND ranking_type="elo"
           AND JSON_UNQUOTE(JSON_EXTRACT(context_json, "$.source"))="elo_ledger"',
        $prefix
    );
    $stmt = $db->prepare($snapshotSql);
    $stmt->bind_param('i', $ids['season']);
    $stmt->execute();
    $assert((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 2, 'Guest reconciliation should leave one ELO snapshot per member for the active event.');
    $stmt->close();

    echo "ELO ledger smoke OK\n";
} finally {
    if ($ids['season'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sranking_snapshots` WHERE season_id=' . (int) $ids['season'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$selo_current_ratings` WHERE season_id=' . (int) $ids['season'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$selo_match_events` WHERE season_id=' . (int) $ids['season'], $prefix));
    }
    if ($ids['tournament'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$smatches` WHERE tournament_id=' . (int) $ids['tournament'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=' . (int) $ids['tournament'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=' . (int) $ids['tournament'], $prefix));
    }
    foreach (['player_a', 'player_b', 'guest'] as $key) {
        if ($ids[$key] > 0) {
            $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=' . (int) $ids[$key], $prefix));
        }
    }
    if ($ids['season'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sseasons` WHERE id=' . (int) $ids['season'], $prefix));
    }
    if ($ids['club'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=' . (int) $ids['club'], $prefix));
    }
}
