<?php

declare(strict_types=1);

/**
 * One-time TEST-only reconciliation before production readiness verification.
 *
 * Manual/kiosk testing can leave a newly completed TEST match after the previous
 * historical reconciliation migrations have already been recorded as applied.
 * Re-run the deterministic logical-order rebuild so Core verification starts from
 * a consistent canonical ledger. Production is deliberately untouched.
 */
return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "0059: skipping production/non-test ELO reconciliation ({$prefix})." . PHP_EOL);
        return;
    }

    $rebuild = require __DIR__ . '/0053_rebuild_elo_in_logical_match_order.php';
    if (!is_callable($rebuild)) {
        throw new RuntimeException('0053 ELO rebuild migration is not callable.');
    }

    fwrite(STDOUT, "0059: reconciling TEST ELO before production readiness verification." . PHP_EOL);
    $rebuild($mysqli, $prefix);
    fwrite(STDOUT, "0059: TEST ELO reconciliation completed." . PHP_EOL);
};
