<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ClubEloPeriodRepository;
use Blindleia\Dartkiosk\Api\Repository\ClubEloReadRepository;
use Blindleia\Dartkiosk\Api\Support\Database;

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

$prefix = (string) getenv('DB_TABLE_PREFIX');
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    throw new RuntimeException('Invalid table prefix for ELO smoke.');
}
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$connection = new mysqli(
    (string) getenv('DB_HOST'),
    (string) getenv('DB_USERNAME'),
    (string) getenv('DB_PASSWORD'),
    (string) getenv('DB_NAME'),
    (int) (getenv('DB_PORT') ?: 3306)
);
$connection->set_charset('utf8mb4');
$db = Database::fromConnection($connection, $prefix);

// Read-only smoke; never opens a transaction that could alter a real match.
$periods = new ClubEloPeriodRepository($db);
$ratings = new ClubEloReadRepository($db);
$clubs = $connection->query("SELECT id FROM `{$prefix}clubs` ORDER BY id")->fetch_all(MYSQLI_ASSOC);
$checked = 0;
$ranked = 0;
foreach ($clubs as $club) {
    $clubId = (int) $club['id'];
    $items = $periods->listForClub($clubId);
    if ($items === []) {
        throw new RuntimeException("Club {$clubId} has no independent ELO period after migration.");
    }
    usort($items, static fn (array $a, array $b) => strcmp($a['starts_on'], $b['starts_on']));
    $unbounded = 0;
    $active = 0;
    $lastEnd = null;
    foreach ($items as $period) {
        if ($lastEnd !== null && $period['starts_on'] <= $lastEnd) {
            throw new RuntimeException("Club {$clubId} has overlapping ELO periods.");
        }
        if ($period['ends_on'] === null) {
            ++$unbounded;
        } else {
            $lastEnd = $period['ends_on'];
        }
        if ($period['is_active']) ++$active;
    }
    if ($unbounded !== 1 || $active !== 1) {
        throw new RuntimeException("Club {$clubId} must have exactly one current active ELO and one open-ended successor/period.");
    }

    $ranking = $ratings->clubRanking($clubId);
    if (!is_array($ranking['items'])) {
        throw new RuntimeException("Club {$clubId} ELO ranking could not be read.");
    }
    $ranked += count($ranking['items']);
    foreach ($ranking['items'] as $player) {
        if ((float) $player['elo_rating'] < 0 || (int) $player['elo_matches_played'] <= 0) {
            throw new RuntimeException("Club {$clubId} has invalid ELO ranking data.");
        }
    }
    if ($ranking['items'] !== []) {
        $player = $ranking['items'][0];
        $history = $ratings->playerTournaments((int) $player['id']);
        if ($history === null || !is_array($history['items']) || !is_array($history['matches'])) {
            throw new RuntimeException("Club {$clubId} failed player ELO history read.");
        }
    }
    ++$checked;
}
echo "CLUB_ELO_SMOKE_OK=yes CLUBS={$checked} RANKED_PLAYERS={$ranked}\n";
