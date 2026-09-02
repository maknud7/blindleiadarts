<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $snapshots = $prefix . 'tournament_elo_snapshots';
    $tournaments = $prefix . 'tournaments';
    $seasons = $prefix . 'seasons';
    $clubs = $prefix . 'clubs';
    $players = $prefix . 'players';
    $events = $prefix . 'elo_match_events';
    $current = $prefix . 'elo_current_ratings';
    $registrations = $prefix . 'tournament_players';

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$snapshots}` (
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `season_id` BIGINT UNSIGNED NOT NULL,
            `club_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `elo_before` DECIMAL(14,6) NOT NULL,
            `elo_after` DECIMAL(14,6) NULL,
            `matches_before` INT UNSIGNED NOT NULL DEFAULT 0,
            `matches_after` INT UNSIGNED NULL,
            `captured_start_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `captured_end_at` DATETIME NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`tournament_id`, `player_id`),
            KEY `idx_tournament_elo_player` (`player_id`, `season_id`, `tournament_id`),
            KEY `idx_tournament_elo_season` (`season_id`, `tournament_id`),
            CONSTRAINT `{$prefix}fk_tournament_elo_tournament` FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_elo_season` FOREIGN KEY (`season_id`) REFERENCES `{$seasons}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_elo_club` FOREIGN KEY (`club_id`) REFERENCES `{$clubs}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_elo_player` FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // Backfill finished/history tournaments from the canonical ELO ledger. The
    // smallest matches_before value is the player's ELO entering a tournament;
    // the largest is the final ELO event in that tournament. This remains valid
    // even when imported event ids were not created in logical match order.
    $sql = "SELECT e.tournament_id,e.season_id,e.club_id,
                   t.start_at,t.end_at,t.status,
                   e.player_a_id,e.rating_a_before,e.rating_a_after,e.matches_before_a,
                   e.player_b_id,e.rating_b_before,e.rating_b_after,e.matches_before_b
            FROM `{$events}` e
            INNER JOIN `{$tournaments}` t ON t.id=e.tournament_id
            WHERE e.status='applied'
              AND e.rating_a_before IS NOT NULL AND e.rating_a_after IS NOT NULL
              AND e.rating_b_before IS NOT NULL AND e.rating_b_after IS NOT NULL";
    $result = $mysqli->query($sql);
    $history = [];
    while ($row = $result->fetch_assoc()) {
        foreach (['a', 'b'] as $side) {
            $playerId = (int) $row['player_' . $side . '_id'];
            $key = (int) $row['tournament_id'] . ':' . $playerId;
            $matchesBefore = (int) $row['matches_before_' . $side];
            $before = (float) $row['rating_' . $side . '_before'];
            $after = (float) $row['rating_' . $side . '_after'];
            if (!isset($history[$key])) {
                $history[$key] = [
                    'tournament_id' => (int) $row['tournament_id'],
                    'season_id' => (int) $row['season_id'],
                    'club_id' => (int) $row['club_id'],
                    'player_id' => $playerId,
                    'first_matches_before' => $matchesBefore,
                    'last_matches_before' => $matchesBefore,
                    'elo_before' => $before,
                    'elo_after' => $after,
                    'matches_before' => $matchesBefore,
                    'matches_after' => $matchesBefore + 1,
                    'start_at' => $row['start_at'],
                    'end_at' => $row['end_at'],
                    'status' => (string) $row['status'],
                ];
                continue;
            }
            if ($matchesBefore < $history[$key]['first_matches_before']) {
                $history[$key]['first_matches_before'] = $matchesBefore;
                $history[$key]['elo_before'] = $before;
                $history[$key]['matches_before'] = $matchesBefore;
            }
            if ($matchesBefore >= $history[$key]['last_matches_before']) {
                $history[$key]['last_matches_before'] = $matchesBefore;
                $history[$key]['elo_after'] = $after;
                $history[$key]['matches_after'] = $matchesBefore + 1;
            }
        }
    }
    $result->free();

    if ($history !== []) {
        $insert = $mysqli->prepare(
            "INSERT INTO `{$snapshots}`
             (tournament_id,season_id,club_id,player_id,elo_before,elo_after,matches_before,matches_after,captured_start_at,captured_end_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
               elo_before=VALUES(elo_before),elo_after=VALUES(elo_after),
               matches_before=VALUES(matches_before),matches_after=VALUES(matches_after),
               captured_start_at=VALUES(captured_start_at),captured_end_at=VALUES(captured_end_at)"
        );
        foreach ($history as $item) {
            $tournamentId = (int) $item['tournament_id'];
            $seasonId = (int) $item['season_id'];
            $clubId = (int) $item['club_id'];
            $playerId = (int) $item['player_id'];
            $before = (float) $item['elo_before'];
            $after = $item['status'] === 'completed' ? (float) $item['elo_after'] : null;
            $matchesBefore = (int) $item['matches_before'];
            $matchesAfter = $item['status'] === 'completed' ? (int) $item['matches_after'] : null;
            $startAt = (string) ($item['start_at'] ?: date('Y-m-d H:i:s'));
            $endAt = $item['status'] === 'completed' ? (string) ($item['end_at'] ?: $startAt) : null;
            $insert->bind_param('iiiiddiiss', $tournamentId, $seasonId, $clubId, $playerId, $before, $after, $matchesBefore, $matchesAfter, $startAt, $endAt);
            $insert->execute();
        }
        $insert->close();
    }

    // Existing in-progress tournaments may have participants who have not yet
    // played an ELO match. Preserve their current rating as the best available
    // start snapshot without overwriting ledger-derived starts above.
    $mysqli->query(
        "INSERT IGNORE INTO `{$snapshots}`
         (tournament_id,season_id,club_id,player_id,elo_before,matches_before,captured_start_at)
         SELECT t.id,t.season_id,t.club_id,tp.player_id,
                COALESCE(ecr.rating,1000),COALESCE(ecr.matches_played,0),COALESCE(t.start_at,NOW())
         FROM `{$tournaments}` t
         INNER JOIN `{$registrations}` tp ON tp.tournament_id=t.id
         LEFT JOIN `{$current}` ecr ON ecr.season_id=t.season_id AND ecr.player_id=tp.player_id
         WHERE t.status='in_progress' AND t.elo_enabled=1 AND t.season_id IS NOT NULL
           AND tp.status IN ('checked_in','registered','eliminated')"
    );
};
