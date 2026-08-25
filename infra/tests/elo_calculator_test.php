<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloCalculator;

$root = dirname(__DIR__, 2);
require $root . '/apps/api/bootstrap.php';

$elo = new EloCalculator();
$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};
$close = static function (float $actual, float $expected, string $message) use ($assert): void {
    $assert(abs($actual - $expected) < 0.000001, $message . " Expected {$expected}, got {$actual}.");
};

$equal = $elo->calculate(1000.0, 1000.0, 10, 10, 1.0);
$close($equal['k_a'], 25.0, 'Player with 10 prior matches must use K=25.');
$close($equal['k_b'], 25.0, 'Opponent with 10 prior matches must use K=25.');
$close($equal['rating_a_after'], 1012.5, 'Equal-rating winner with K=25 must gain 12.5.');
$close($equal['rating_b_after'], 987.5, 'Equal-rating loser with K=25 must lose 12.5.');
$assert($equal['matches_after_a'] === 11 && $equal['matches_after_b'] === 11, 'Match counts were not incremented.');

$mixed = $elo->calculate(1000.0, 1000.0, 10, 11, 1.0);
$close($mixed['k_a'], 25.0, '10 prior matches must still use provisional K.');
$close($mixed['k_b'], 15.0, '11 prior matches must use established K.');
$close($mixed['delta_a'], 12.5, 'Independent K for winner is wrong.');
$close($mixed['delta_b'], -7.5, 'Independent K for loser is wrong.');

$unequal = $elo->calculate(1018.3, 1077.3, 15, 18, 1.0);
$assert($unequal['rating_a_after'] > 1018.3, 'Underdog win must increase rating.');
$assert($unequal['rating_b_after'] < 1077.3, 'Favourite loss must decrease rating.');
$assert(abs($unequal['delta_a'] + $unequal['delta_b']) < 0.000001, 'Equal K factors should produce zero-sum deltas.');
$assert(abs($unequal['rating_a_after'] * 10 - round($unequal['rating_a_after'] * 10)) > 0.000001, 'Calculator appears to round prematurely.');

$draw = $elo->calculate(1000.0, 1000.0, 11, 11, 0.5);
$close($draw['delta_a'], 0.0, 'Equal-rating draw should not move player A.');
$close($draw['delta_b'], 0.0, 'Equal-rating draw should not move player B.');

echo "ELO calculator tests OK\n";
