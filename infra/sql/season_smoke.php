<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\SeasonRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

$config = Config::load(dirname(__DIR__, 2) . '/apps/api');
$database = new Database($config);
$db = $database->connection();
$prefix = $database->tablePrefix();
$repo = new SeasonRepository($database);

$clubId = (int) ($db->query("SELECT id FROM `{$prefix}clubs` ORDER BY id LIMIT 1")->fetch_assoc()['id'] ?? 0);
if ($clubId <= 0) {
    throw new RuntimeException('Season smoke requires one club.');
}

$db->begin_transaction();
try {
    $season = $repo->create($clubId, [
        'name' => 'Season smoke ' . bin2hex(random_bytes(3)),
        'ranking_method' => 'match_points',
        'points_win' => 2,
        'points_draw' => 1,
        'points_loss' => 0,
    ]);
    $seasonId = (int) ($season['id'] ?? 0);
    if ($seasonId <= 0) throw new RuntimeException('Season was not created.');

    $playerStmt = $db->prepare("INSERT INTO `{$prefix}players` (club_id,display_name,is_active) VALUES (?, ?, 1)");
    $nameA = 'Season Smoke A ' . bin2hex(random_bytes(2));
    $playerStmt->bind_param('is', $clubId, $nameA);
    $playerStmt->execute();
    $playerA = (int) $playerStmt->insert_id;
    $nameB = 'Season Smoke B ' . bin2hex(random_bytes(2));
    $playerStmt->bind_param('is', $clubId, $nameB);
    $playerStmt->execute();
    $playerB = (int) $playerStmt->insert_id;
    $playerStmt->close();

    $slug = 'season-smoke-' . bin2hex(random_bytes(4));
    $tournamentStmt = $db->prepare("INSERT INTO `{$prefix}tournaments` (club_id,season_id,name,slug,provider_system,status) VALUES (?,?,'Season smoke tournament',?,'local','completed')");
    $tournamentStmt->bind_param('iis', $clubId, $seasonId, $slug);
    $tournamentStmt->execute();
    $tournamentId = (int) $tournamentStmt->insert_id;
    $tournamentStmt->close();

    $tp = $db->prepare("INSERT INTO `{$prefix}tournament_players` (tournament_id,player_id,status) VALUES (?,?,'checked_in')");
    $tp->bind_param('ii', $tournamentId, $playerA); $tp->execute();
    $tp->bind_param('ii', $tournamentId, $playerB); $tp->execute();
    $tp->close();

    $match = $db->prepare("INSERT INTO `{$prefix}matches` (tournament_id,status,player_a_id,player_b_id,winner_player_id,finished_at) VALUES (?,'completed',?,?,?,NOW())");
    $match->bind_param('iiii', $tournamentId, $playerA, $playerB, $playerA);
    $match->execute();
    $matchId = (int) $match->insert_id;
    $match->close();

    $leg = $db->prepare("INSERT INTO `{$prefix}legs` (match_id,leg_number,starting_player_id,winner_player_id,status,finished_at) VALUES (?,?,?,?,'completed',NOW())");
    $number = 1; $leg->bind_param('iiii', $matchId, $number, $playerA, $playerA); $leg->execute();
    $number = 2; $leg->bind_param('iiii', $matchId, $number, $playerB, $playerB); $leg->execute();
    $number = 3; $leg->bind_param('iiii', $matchId, $number, $playerA, $playerA); $leg->execute();
    $leg->close();

    $standings = $repo->standings($seasonId);
    if (count($standings) !== 2) throw new RuntimeException('Expected two season standings rows.');
    if ((int) $standings[0]['id'] !== $playerA || (int) $standings[0]['position'] !== 1) throw new RuntimeException('Season winner ordering is incorrect.');
    if ((float) $standings[0]['points'] !== 2.0) throw new RuntimeException('Season match points are incorrect.');
    if ((int) $standings[0]['leg_diff'] !== 1) throw new RuntimeException('Season leg difference is incorrect.');

    $completed = $repo->complete($seasonId);
    if ((int) ($completed['champion_player_id'] ?? 0) !== $playerA || (string) ($completed['status'] ?? '') !== 'completed') {
        throw new RuntimeException('Season champion was not locked correctly.');
    }

    echo "SEASON_SMOKE_OK=yes\n";
    $db->rollback();
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}
