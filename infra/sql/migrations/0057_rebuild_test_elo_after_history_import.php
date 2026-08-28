<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        echo "0057: skipping history-import ELO rebuild outside TEST ({$prefix}).\n";
        return;
    }

    $rebuild = require __DIR__ . '/0053_rebuild_elo_in_logical_match_order.php';
    if (!is_callable($rebuild)) {
        throw new RuntimeException('0053 ELO rebuild migration is not callable.');
    }

    echo "0057: rebuilding TEST ELO after historical imports.\n";
    $rebuild($mysqli, $prefix);
    echo "0057: TEST ELO rebuild completed.\n";
};
