<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

use Blindleia\Dartkiosk\Api\Service\TournamentGroupService;

$service = new TournamentGroupService();
$players = [];
for ($i = 1; $i <= 12; $i++) {
    $players[] = [
        'tournament_player_id' => $i,
        'player_id' => $i,
        'display_name' => 'Spiller ' . $i,
        'elo_rating' => 1300 - ($i * 10),
        'elo_rating_source' => 'test',
    ];
}

$snake = $service->allocate($players, 3, 'elo_snake', 42);
$snakeSeeds = array_map(
    static fn (array $group): array => array_map(static fn (array $player): int => (int) $player['seed_number'], $group['players']),
    $snake['groups']
);
$expectedSnake = [[1, 6, 7, 12], [2, 5, 8, 11], [3, 4, 9, 10]];
if ($snakeSeeds !== $expectedSnake) {
    fwrite(STDERR, 'Unexpected snake seeding: ' . json_encode($snakeSeeds) . PHP_EOL);
    exit(1);
}

$randomA = $service->allocate($players, 3, 'random', 20260825);
$randomB = $service->allocate($players, 3, 'random', 20260825);
if ($randomA !== $randomB) {
    fwrite(STDERR, "Random draw is not reproducible with the same draw seed.\n");
    exit(1);
}

$fivePlayers = array_slice($players, 0, 5);
$rounds = $service->roundRobin($fivePlayers);
$pairs = [];
foreach ($rounds as $roundNumber => $round) {
    $seen = [];
    foreach ($round as $match) {
        foreach (['player_a_id', 'player_b_id'] as $field) {
            $id = (int) $match[$field];
            if (isset($seen[$id])) {
                fwrite(STDERR, 'Player occurs twice in round ' . ($roundNumber + 1) . PHP_EOL);
                exit(1);
            }
            $seen[$id] = true;
        }
        $ids = [(int) $match['player_a_id'], (int) $match['player_b_id']];
        sort($ids);
        $pairs[implode(':', $ids)] = true;
    }
}
if (count($pairs) !== 10) {
    fwrite(STDERR, 'Expected 10 unique pairings for five players, got ' . count($pairs) . PHP_EOL);
    exit(1);
}

echo "Tournament group engine checks passed.\n";
