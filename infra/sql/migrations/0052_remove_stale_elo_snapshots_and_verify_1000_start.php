<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $events = $prefix . 'elo_match_events';
    $snapshots = $prefix . 'ranking_snapshots';

    // The ledger is canonical. Older/manual ELO snapshots were still returned by the
    // player profile together with ledger snapshots, which made the UI stitch a
    // fictitious sequence (including apparent reversals around 1000).
    $mysqli->query(
        "DELETE rs
         FROM `{$snapshots}` rs
         INNER JOIN (
             SELECT DISTINCT season_id
             FROM `{$events}`
             WHERE status='applied'
         ) s ON s.season_id=rs.season_id
         WHERE rs.ranking_type='elo'
           AND (
             rs.context_json IS NULL
             OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.source')), '') <> 'elo_ledger'
           )"
    );
    $removed = $mysqli->affected_rows;

    // Every player's first ELO event in every rebuilt season must start at exactly
    // 1000. This is a product rule for a new Blindleia season, not a display fallback.
    $rows = $mysqli->query(
        "SELECT season_id, player_id, rating_before, applied_at, event_id
         FROM (
             SELECT season_id, player_a_id AS player_id, rating_a_before AS rating_before,
                    applied_at, id AS event_id
             FROM `{$events}` WHERE status='applied'
             UNION ALL
             SELECT season_id, player_b_id AS player_id, rating_b_before AS rating_before,
                    applied_at, id AS event_id
             FROM `{$events}` WHERE status='applied'
         ) x
         ORDER BY season_id ASC, player_id ASC, applied_at ASC, event_id ASC"
    )->fetch_all(MYSQLI_ASSOC);

    $seen = [];
    $badStarts = [];
    foreach ($rows as $row) {
        $key = (int) $row['season_id'] . ':' . (int) $row['player_id'];
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $before = (float) $row['rating_before'];
        if (abs($before - 1000.0) > 0.0001) {
            $badStarts[] = sprintf('%s=%.4f', $key, $before);
        }
    }

    if ($badStarts !== []) {
        throw new RuntimeException(
            'ELO start verification failed; first match must start at 1000: ' . implode(', ', $badStarts)
        );
    }

    $stale = (int) (($mysqli->query(
        "SELECT COUNT(*) AS c
         FROM `{$snapshots}` rs
         INNER JOIN (
             SELECT DISTINCT season_id
             FROM `{$events}`
             WHERE status='applied'
         ) s ON s.season_id=rs.season_id
         WHERE rs.ranking_type='elo'
           AND (
             rs.context_json IS NULL
             OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.source')), '') <> 'elo_ledger'
           )"
    )->fetch_assoc()['c'] ?? 0));

    if ($stale !== 0) {
        throw new RuntimeException("Stale ELO snapshots remain after cleanup: {$stale}");
    }

    fwrite(
        STDOUT,
        sprintf(
            "ELO history cleanup complete: removed %d stale snapshot(s); verified 1000 start for %d player-season(s).\n",
            $removed,
            count($seen)
        )
    );
};
