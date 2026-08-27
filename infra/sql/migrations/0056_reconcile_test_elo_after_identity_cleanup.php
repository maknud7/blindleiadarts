<?php

declare(strict_types=1);

/**
 * Rebuild TEST ELO after the automatic player identity cleanup in 0055.
 *
 * 0055 may rewrite canonical player references after the earlier ELO rebuilds
 * have already been recorded as applied migrations. Replaying the proven 0053
 * rebuild once more keeps match events, current ratings and match snapshots in
 * lock-step with the now-canonical match/player identities.
 *
 * Production is deliberately untouched; production identity merges use the
 * audited admin workflow and reconcile derived state through normal runtime.
 */
return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "Skipping TEST ELO reconciliation for non-test prefix: {$prefix}" . PHP_EOL);
        return;
    }

    $rebuild = require __DIR__ . '/0053_rebuild_elo_in_logical_match_order.php';
    if (!is_callable($rebuild)) {
        throw new RuntimeException('0053 ELO rebuild migration is not callable.');
    }

    $rebuild($mysqli, $prefix);
    fwrite(STDOUT, "TEST ELO reconciliation after identity cleanup complete." . PHP_EOL);
};
