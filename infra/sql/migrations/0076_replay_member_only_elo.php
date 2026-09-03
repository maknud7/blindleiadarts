<?php

declare(strict_types=1);

/**
 * Superseded by 0077_replay_member_only_elo_final.php.
 *
 * An early TEST verification started the original row-by-row replay before the
 * optimized implementation landed. Keep this migration name as a harmless marker
 * so environments that have not seen it yet can advance directly to 0077.
 */
return static function (mysqli $mysqli, string $prefix): void {
    fwrite(STDOUT, "0076: superseded; final member-only ELO replay runs in 0077 for {$prefix}." . PHP_EOL);
};
