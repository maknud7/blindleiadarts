<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloCalculator;

require __DIR__ . '/../../api/bootstrap.php';

$raw = stream_get_contents(STDIN);
$cases = json_decode($raw !== false ? $raw : '', true);
if (!is_array($cases)) {
    fwrite(STDERR, "Expected JSON array on stdin.\n");
    exit(2);
}

$calculator = new EloCalculator();
$results = [];
foreach ($cases as $case) {
    if (!is_array($case)) {
        $results[] = null;
        continue;
    }
    $results[] = $calculator->calculate(
        (float) ($case['rating_a'] ?? 1000.0),
        (float) ($case['rating_b'] ?? 1000.0),
        (int) ($case['matches_a'] ?? 0),
        (int) ($case['matches_b'] ?? 0),
        (float) ($case['score_a'] ?? 0.5)
    );
}

fwrite(STDOUT, json_encode($results, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . PHP_EOL);
