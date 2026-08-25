<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\ScoliaSectorMapper;

require dirname(__DIR__) . '/bootstrap.php';

$mapper = new ScoliaSectorMapper();
$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$cases = [
    ['T20', false, 'T', 20, 60],
    ['D16', false, 'D', 16, 32],
    ['S5', false, 'S', 5, 5],
    ['s5', false, 'S', 5, 5],
    ['25', false, 'S', 'BULL', 25],
    ['Bull', false, 'D', 'BULL', 50],
    ['None', false, 'S', 0, 0],
    ['T20', true, 'S', 0, 0],
];

foreach ($cases as [$sector, $bounce, $multiplier, $value, $score]) {
    $dart = $mapper->toCanonical($sector, $bounce);
    $assert($dart['multiplier'] === $multiplier, "Wrong multiplier for {$sector}");
    $assert($dart['value'] === $value, "Wrong value for {$sector}");
    $assert($dart['score'] === $score, "Wrong score for {$sector}");
}

echo "Scolia sector mapper OK\n";
