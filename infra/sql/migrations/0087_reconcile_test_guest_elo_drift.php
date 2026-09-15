<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloLedgerService;
use Blindleia\Dartkiosk\Api\Support\Database;

return static function (mysqli $mysqli, string $prefix): void {
    // This repair is deliberately TEST-only. PROD ELO data must never be changed
    // as a side effect of a TEST migration/gate repair.
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "0087: skipped guest ELO reconciliation for non-TEST prefix {$prefix}." . PHP_EOL);
        return;
    }

    $root = dirname(__DIR__, 3);
    require_once $root . '/apps/api/bootstrap.php';

    $database = Database::fromConnection($mysqli, $prefix);
    $result = (new EloLedgerService($database))->reconcileGuestMatches();

    fwrite(STDOUT, sprintf(
        "0087: TEST guest ELO reconciliation completed: reverted_events=%d rebuilt_seasons=%d\n",
        (int) ($result['reverted_events'] ?? 0),
        (int) ($result['rebuilt_seasons'] ?? 0)
    ));
};
