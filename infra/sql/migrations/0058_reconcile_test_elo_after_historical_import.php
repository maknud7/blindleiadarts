<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        echo "0058: skipping historical-import ELO reconciliation outside TEST ({$prefix}).\n";
        return;
    }

    $rebuild = require __DIR__ . '/0053_rebuild_elo_in_logical_match_order.php';
    if (!is_callable($rebuild)) {
        throw new RuntimeException('0053 ELO rebuild migration is not callable.');
    }

    echo "0058: reconciling TEST ELO after completed historical import.\n";
    $rebuild($mysqli, $prefix);
    echo "0058: TEST ELO reconciliation completed.\n";
};
