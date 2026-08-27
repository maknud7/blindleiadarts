<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $rebuildFile = __DIR__ . '/0050_rebuild_elo_from_completed_matches.php';
    $rebuild = require $rebuildFile;
    if (!is_callable($rebuild)) {
        throw new RuntimeException('ELO rebuild migration is not callable.');
    }

    // Run the deterministic rebuild once more under a new migration name. This makes
    // the historical backfill safe even if an earlier deployment reached migration
    // 0050 before a later code correction was deployed.
    $rebuild($mysqli, $prefix);

    $eligibleSql = "
        SELECT COUNT(*) AS c
        FROM `{$prefix}matches` m
        INNER JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
        WHERE m.status='completed' AND t.elo_enabled=1 AND t.season_id IS NOT NULL";
    $eligible = (int) (($mysqli->query($eligibleSql)->fetch_assoc()['c'] ?? 0));

    $missingSql = "
        SELECT COUNT(*) AS c
        FROM `{$prefix}matches` m
        INNER JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
        LEFT JOIN `{$prefix}elo_match_events` e ON e.match_id=m.id AND e.status='applied'
        WHERE m.status='completed' AND t.elo_enabled=1 AND t.season_id IS NOT NULL
          AND (
            e.id IS NULL
            OR e.rating_a_before IS NULL OR e.rating_b_before IS NULL
            OR e.rating_a_after IS NULL OR e.rating_b_after IS NULL
            OR e.delta_a IS NULL OR e.delta_b IS NULL
            OR NOT (e.winner_player_id <=> m.winner_player_id)
          )";
    $missing = (int) (($mysqli->query($missingSql)->fetch_assoc()['c'] ?? 0));
    if ($missing !== 0) {
        throw new RuntimeException("Historical ELO rebuild incomplete: {$missing} of {$eligible} eligible matches are missing ELO calculations.");
    }

    $snapshotMissingSql = "
        SELECT COUNT(*) AS c
        FROM `{$prefix}matches` m
        INNER JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
        WHERE m.status='completed' AND t.elo_enabled=1 AND t.season_id IS NOT NULL
          AND (
            SELECT COUNT(*)
            FROM `{$prefix}ranking_snapshots` rs
            WHERE rs.ranking_type='elo'
              AND rs.season_id=t.season_id
              AND JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.source'))='elo_ledger'
              AND CAST(JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.match_id')) AS UNSIGNED)=m.id
          ) <> 2";
    $snapshotMissing = (int) (($mysqli->query($snapshotMissingSql)->fetch_assoc()['c'] ?? 0));
    if ($snapshotMissing !== 0) {
        throw new RuntimeException("Historical ELO snapshots incomplete for {$snapshotMissing} match(es).");
    }

    fwrite(STDOUT, "Historical ELO verified for {$eligible} completed match(es).\n");
};
