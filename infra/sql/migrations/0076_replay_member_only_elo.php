<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\EloCanonicalReplayService;
use Blindleia\Dartkiosk\Api\Support\Database;

return static function (mysqli $mysqli, string $prefix): void {
    $root = dirname(__DIR__, 3);
    require_once $root . '/apps/api/bootstrap.php';

    $database = Database::fromConnection($mysqli, $prefix);
    $result = (new EloCanonicalReplayService($database))->replay();

    fwrite(STDOUT, sprintf(
        "0076: canonical ELO replay completed for %s: completed_matches=%d guest_events_reverted=%d seasons_rebuilt=%d\n",
        $prefix,
        (int) $result['completed_matches'],
        (int) $result['guest_events_reverted'],
        (int) $result['seasons_rebuilt']
    ));
};
