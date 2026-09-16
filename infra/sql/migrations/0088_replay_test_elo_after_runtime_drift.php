<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloCanonicalReplayService;
use Blindleia\Dartkiosk\Api\Support\Database;

return static function (mysqli $mysqli, string $prefix): void {
    // Persistent hosted TEST drift left one eligible completed match without a
    // canonical ELO event. Rebuild deterministically from completed matches in
    // the isolated TEST runtime. Never touch PROD as part of this repair.
    if ($prefix !== 'bd_test_') {
        fwrite(STDOUT, "0088: skipped canonical ELO replay for non-TEST prefix {$prefix}." . PHP_EOL);
        return;
    }

    $root = dirname(__DIR__, 3);
    require_once $root . '/apps/api/bootstrap.php';

    $database = Database::fromConnection($mysqli, $prefix);
    $result = (new EloCanonicalReplayService($database))->replay();

    fwrite(STDOUT, sprintf(
        "0088: TEST canonical ELO replay completed: completed_matches=%d eligible_matches=%d guest_neutral_matches=%d seasons_rebuilt=%d\n",
        (int) ($result['completed_matches'] ?? 0),
        (int) ($result['eligible_matches'] ?? 0),
        (int) ($result['guest_neutral_matches'] ?? 0),
        (int) ($result['seasons_rebuilt'] ?? 0)
    ));
};
