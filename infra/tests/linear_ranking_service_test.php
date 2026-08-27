<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\LinearRankingService;

require dirname(__DIR__, 2) . '/apps/api/bootstrap.php';

$cases = [
    1 => 1,
    2 => 2,
    3 => 3,
    4 => 3,
    5 => 4,
    8 => 4,
    9 => 5,
    16 => 5,
    17 => 6,
    32 => 6,
    33 => 7,
    64 => 7,
    65 => 8,
    128 => 8,
    129 => 9,
    256 => 9,
    257 => 10,
    512 => 10,
];

foreach ($cases as $entrants => $expected) {
    $actual = LinearRankingService::maximumPoints($entrants);
    if ($actual !== $expected) {
        throw new RuntimeException("Linear points failed for {$entrants} entrants: expected {$expected}, got {$actual}.");
    }
}

echo "Linear ranking field-size rules OK\n";
