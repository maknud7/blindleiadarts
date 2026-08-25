<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\MatchScoringRepository;
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
$ids = ['club' => 0, 'tournament' => 0, 'kiosk' => 0, 'player_a' => 0, 'player_b' => 0, 'match' => 0];

try {
    $clubName = 'Scoring Smoke ' . $suffix;
    $clubSlug = 'scoring-smoke-' . $suffix;
    $sql = sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $prefix);
    $stmt = $db->prepare($sql);
    $stmt->bind_param('ss', $clubName, $clubSlug);
    $stmt->execute();
    $ids['club'] = (int) $stmt->insert_id;
    $stmt->close();

    $playerSql = sprintf('INSERT INTO `%1$splayers` (club_id, display_name) VALUES (?, ?)', $prefix);
    foreach (['Smoke A', 'Smoke B'] as $index => $name) {
        $stmt = $db->prepare($playerSql);
        $stmt->bind_param('is', $ids['club'], $name);
        $stmt->execute();
        $ids[$index === 0 ? 'player_a' : 'player_b'] = (int) $stmt->insert_id;
        $stmt->close();
    }

    $tournamentName = 'Scoring Smoke Tournament ' . $suffix;
    $tournamentSlug = 'scoring-smoke-tournament-' . $suffix;
    $sql = sprintf(
        'INSERT INTO `%1$stournaments` (club_id, name, slug, provider_system, status, start_at)
         VALUES (?, ?, ?, "local", "ready", NOW())',
        $prefix
    );
    $stmt = $db->prepare($sql);
    $stmt->bind_param('iss', $ids['club'], $tournamentName, $tournamentSlug);
    $stmt->execute();
    $ids['tournament'] = (int) $stmt->insert_id;
    $stmt->close();

    $kioskCode = 'SMOKE-' . strtoupper(substr($suffix, 0, 8));
    $kioskName = 'Smoke Board';
    $boardNumber = 999;
    $sql = sprintf(
        'INSERT INTO `%1$skiosks` (club_id, code, name, board_number) VALUES (?, ?, ?, ?)',
        $prefix
    );
    $stmt = $db->prepare($sql);
    $stmt->bind_param('issi', $ids['club'], $kioskCode, $kioskName, $boardNumber);
    $stmt->execute();
    $ids['kiosk'] = (int) $stmt->insert_id;
    $stmt->close();

    $sql = sprintf(
        'INSERT INTO `%1$smatches`
         (tournament_id, kiosk_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id)
         VALUES (?, ?, "assigned", 1, 1, ?, ?)',
        $prefix
    );
    $stmt = $db->prepare($sql);
    $stmt->bind_param('iiii', $ids['tournament'], $ids['kiosk'], $ids['player_a'], $ids['player_b']);
    $stmt->execute();
    $ids['match'] = (int) $stmt->insert_id;
    $stmt->close();

    $scoring = new MatchScoringRepository($database);
    $scoring->startMatch($ids['kiosk']);

    $request180 = 'smoke-' . $suffix . '-a180';
    $scoring->recordVisit($ids['kiosk'], ['input_mode' => 'sum', 'score' => 180, 'darts_used' => 3, 'request_id' => $request180]);
    // Same request id must not create a second visit even though it arrives after turn changed.
    $scoring->recordVisit($ids['kiosk'], ['input_mode' => 'sum', 'score' => 180, 'darts_used' => 3, 'request_id' => $request180]);

    $countSql = sprintf('SELECT COUNT(*) AS c FROM `%1$svisits` WHERE match_id=?', $prefix);
    $stmt = $db->prepare($countSql);
    $stmt->bind_param('i', $ids['match']);
    $stmt->execute();
    $assert((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 1, 'Duplicate request_id inserted a second visit.');
    $stmt->close();

    $scoring->recordVisit($ids['kiosk'], ['input_mode' => 'sum', 'score' => 60, 'darts_used' => 3]);
    $scoring->recordVisit($ids['kiosk'], ['input_mode' => 'sum', 'score' => 160, 'darts_used' => 3]);
    $scoring->recordVisit($ids['kiosk'], ['input_mode' => 'sum', 'score' => 60, 'darts_used' => 3]);
    $scoring->recordVisit($ids['kiosk'], [
        'input_mode' => 'per_dart',
        'darts_used' => 3,
        'darts' => [
            ['multiplier' => 'T', 'value' => 20],
            ['multiplier' => 'T', 'value' => 17],
            ['multiplier' => 'D', 'value' => 'BULL'],
        ],
        'request_id' => 'smoke-' . $suffix . '-checkout',
    ]);

    $matchSql = sprintf('SELECT status, winner_player_id FROM `%1$smatches` WHERE id=?', $prefix);
    $stmt = $db->prepare($matchSql);
    $stmt->bind_param('i', $ids['match']);
    $stmt->execute();
    $match = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert(($match['status'] ?? null) === 'completed', 'Match did not complete after checkout.');
    $assert((int) ($match['winner_player_id'] ?? 0) === $ids['player_a'], 'Wrong match winner.');

    $statsSql = sprintf(
        'SELECT legs_won, average, darts_thrown, highest_checkout, score_140_plus, score_180
         FROM `%1$smatch_statistics` WHERE match_id=? AND player_id=?',
        $prefix
    );
    $stmt = $db->prepare($statsSql);
    $stmt->bind_param('ii', $ids['match'], $ids['player_a']);
    $stmt->execute();
    $stats = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((int) ($stats['legs_won'] ?? 0) === 1, 'Statistics did not record leg win.');
    $assert(abs((float) ($stats['average'] ?? 0) - 167.0) < 0.01, 'Unexpected three-dart average.');
    $assert((int) ($stats['darts_thrown'] ?? 0) === 9, 'Unexpected darts thrown.');
    $assert((int) ($stats['highest_checkout'] ?? 0) === 161, 'Highest checkout was not recorded.');
    $assert((int) ($stats['score_180'] ?? 0) === 1, '180 was not recorded.');
    $assert((int) ($stats['score_140_plus'] ?? 0) === 2, '140+ count was not recorded.');

    $scoring->undoLastVisit($ids['kiosk']);

    $stmt = $db->prepare($matchSql);
    $stmt->bind_param('i', $ids['match']);
    $stmt->execute();
    $match = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert(($match['status'] ?? null) === 'in_progress', 'Undo did not reopen completed match.');
    $assert($match['winner_player_id'] === null, 'Undo did not clear match winner.');

    $stmt = $db->prepare($statsSql);
    $stmt->bind_param('ii', $ids['match'], $ids['player_a']);
    $stmt->execute();
    $stats = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $assert((int) ($stats['legs_won'] ?? -1) === 0, 'Undo did not rebuild leg wins.');
    $assert((int) ($stats['highest_checkout'] ?? -1) === 0, 'Undo did not rebuild highest checkout.');
    $assert((int) ($stats['darts_thrown'] ?? 0) === 6, 'Undo did not rebuild darts thrown.');

    echo "Match scoring smoke OK\n";
} finally {
    if ($ids['match'] > 0) {
        foreach (['match_statistics', 'live_match_states'] as $table) {
            $db->query(sprintf('DELETE FROM `%1$s%2$s` WHERE match_id=' . (int) $ids['match'], $prefix, $table));
        }
        $db->query(sprintf('DELETE FROM `%1$svisits` WHERE match_id=' . (int) $ids['match'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$slegs` WHERE match_id=' . (int) $ids['match'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$smatches` WHERE id=' . (int) $ids['match'], $prefix));
    }
    if ($ids['kiosk'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$skiosks` WHERE id=' . (int) $ids['kiosk'], $prefix));
    }
    if ($ids['tournament'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$stournament_summaries` WHERE tournament_id=' . (int) $ids['tournament'], $prefix));
        $db->query(sprintf('DELETE FROM `%1$stournaments` WHERE id=' . (int) $ids['tournament'], $prefix));
    }
    foreach (['player_a', 'player_b'] as $key) {
        if ($ids[$key] > 0) {
            $db->query(sprintf('DELETE FROM `%1$splayers` WHERE id=' . (int) $ids[$key], $prefix));
        }
    }
    if ($ids['club'] > 0) {
        $db->query(sprintf('DELETE FROM `%1$sclubs` WHERE id=' . (int) $ids['club'], $prefix));
    }
}
