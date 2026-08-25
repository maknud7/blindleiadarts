<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

use Blindleia\Dartkiosk\Api\Service\SingleEliminationService;

$service = new SingleEliminationService();

$cases = [2 => 2, 3 => 4, 4 => 4, 5 => 8, 6 => 8, 8 => 8, 9 => 16, 17 => 32];
foreach ($cases as $players => $expected) {
    $actual = $service->bracketSize($players);
    if ($actual !== $expected) {
        fwrite(STDERR, "Unexpected bracket size for {$players}: {$actual}, expected {$expected}.\n");
        exit(1);
    }
}

$expected8 = [1, 8, 4, 5, 2, 7, 3, 6];
if ($service->seedOrder(8) !== $expected8) {
    fwrite(STDERR, 'Unexpected 8-player seed order: ' . json_encode($service->seedOrder(8)) . PHP_EOL);
    exit(1);
}
if ($service->roundLabel(8, 1) !== 'Kvartfinale'
    || $service->roundLabel(8, 2) !== 'Semifinale'
    || $service->roundLabel(8, 3) !== 'Finale') {
    fwrite(STDERR, "Unexpected playoff round labels.\n");
    exit(1);
}

$qualifiers = [
    ['player_id'=>1,'display_name'=>'A1','source_group_position'=>1,'points'=>6,'leg_diff'=>4,'legs_won'=>6,'seed_number'=>3],
    ['player_id'=>2,'display_name'=>'B1','source_group_position'=>1,'points'=>8,'leg_diff'=>5,'legs_won'=>7,'seed_number'=>5],
    ['player_id'=>3,'display_name'=>'A2','source_group_position'=>2,'points'=>5,'leg_diff'=>2,'legs_won'=>5,'seed_number'=>1],
    ['player_id'=>4,'display_name'=>'B2','source_group_position'=>2,'points'=>6,'leg_diff'=>3,'legs_won'=>5,'seed_number'=>2],
];
$seeded = $service->seedQualifiers($qualifiers);
$order = array_map(static fn (array $row): int => (int) $row['player_id'], $seeded);
if ($order !== [2, 1, 4, 3]) {
    fwrite(STDERR, 'Unexpected qualifier seeding: ' . json_encode($order) . PHP_EOL);
    exit(1);
}
foreach ($seeded as $index => $row) {
    if ((int) $row['playoff_seed'] !== $index + 1) {
        fwrite(STDERR, "Playoff seed numbers are not sequential.\n");
        exit(1);
    }
}

// Three groups sending two players each creates six qualifiers in an 8-slot
// bracket. Lower-tier seeds may move among themselves to avoid an immediate
// rematch against their own group winner.
$threeGroups = [
    ['player_id'=>11,'display_name'=>'A1','source_group_id'=>101,'source_group_position'=>1,'points'=>8,'leg_diff'=>5,'legs_won'=>7,'seed_number'=>1],
    ['player_id'=>21,'display_name'=>'B1','source_group_id'=>102,'source_group_position'=>1,'points'=>7,'leg_diff'=>4,'legs_won'=>6,'seed_number'=>2],
    ['player_id'=>31,'display_name'=>'C1','source_group_id'=>103,'source_group_position'=>1,'points'=>6,'leg_diff'=>3,'legs_won'=>5,'seed_number'=>3],
    ['player_id'=>12,'display_name'=>'A2','source_group_id'=>101,'source_group_position'=>2,'points'=>5,'leg_diff'=>2,'legs_won'=>4,'seed_number'=>4],
    ['player_id'=>22,'display_name'=>'B2','source_group_id'=>102,'source_group_position'=>2,'points'=>4,'leg_diff'=>1,'legs_won'=>3,'seed_number'=>5],
    ['player_id'=>32,'display_name'=>'C2','source_group_id'=>103,'source_group_position'=>2,'points'=>3,'leg_diff'=>0,'legs_won'=>2,'seed_number'=>6],
];
$seededThreeGroups = $service->seedQualifiers($threeGroups);
$bySeed = [];
foreach ($seededThreeGroups as $row) {
    $bySeed[(int) $row['playoff_seed']] = $row;
}
$order8 = $service->seedOrder(8);
foreach (array_chunk($order8, 2) as [$seedA, $seedB]) {
    $a = $bySeed[$seedA] ?? null;
    $b = $bySeed[$seedB] ?? null;
    if ($a === null || $b === null) {
        continue; // bye
    }
    if ((int) $a['source_group_id'] === (int) $b['source_group_id']) {
        fwrite(STDERR, sprintf(
            "Same-group first-round rematch remained for group %d: seed %d vs seed %d.\n",
            (int) $a['source_group_id'],
            $seedA,
            $seedB
        ));
        exit(1);
    }
}

echo "Single elimination service checks passed.\n";
