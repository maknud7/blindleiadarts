<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $tournaments = $prefix . 'tournaments';
    $seasons = $prefix . 'seasons';
    $clubs = $prefix . 'clubs';
    $players = $prefix . 'players';
    $matches = $prefix . 'matches';
    $events = $prefix . 'elo_match_events';
    $current = $prefix . 'elo_current_ratings';

    $column = $mysqli->query("SHOW COLUMNS FROM `{$tournaments}` LIKE 'elo_enabled'");
    if ($column->num_rows === 0) {
        $mysqli->query("ALTER TABLE `{$tournaments}` ADD COLUMN `elo_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `max_visits_per_leg`");
    }
    $column->free();

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$events}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `match_id` BIGINT UNSIGNED NOT NULL,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `season_id` BIGINT UNSIGNED NOT NULL,
            `club_id` BIGINT UNSIGNED NOT NULL,
            `player_a_id` BIGINT UNSIGNED NOT NULL,
            `player_b_id` BIGINT UNSIGNED NOT NULL,
            `winner_player_id` BIGINT UNSIGNED NULL,
            `score_a` DECIMAL(4,3) NOT NULL,
            `score_b` DECIMAL(4,3) NOT NULL,
            `rating_a_before` DECIMAL(14,6) NULL,
            `rating_b_before` DECIMAL(14,6) NULL,
            `rating_a_after` DECIMAL(14,6) NULL,
            `rating_b_after` DECIMAL(14,6) NULL,
            `delta_a` DECIMAL(14,6) NULL,
            `delta_b` DECIMAL(14,6) NULL,
            `matches_before_a` INT UNSIGNED NULL,
            `matches_before_b` INT UNSIGNED NULL,
            `k_a` DECIMAL(8,3) NULL,
            `k_b` DECIMAL(8,3) NULL,
            `status` ENUM('applied','reverted') NOT NULL DEFAULT 'applied',
            `applied_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            `reverted_at` DATETIME(6) NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_elo_match_events_match` (`match_id`),
            KEY `idx_elo_match_events_scope` (`season_id`, `status`, `applied_at`, `id`),
            KEY `idx_elo_match_events_player_a` (`player_a_id`),
            KEY `idx_elo_match_events_player_b` (`player_b_id`),
            CONSTRAINT `{$prefix}fk_elo_events_match` FOREIGN KEY (`match_id`) REFERENCES `{$matches}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_tournament` FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_season` FOREIGN KEY (`season_id`) REFERENCES `{$seasons}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_club` FOREIGN KEY (`club_id`) REFERENCES `{$clubs}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_player_a` FOREIGN KEY (`player_a_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_player_b` FOREIGN KEY (`player_b_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_events_winner` FOREIGN KEY (`winner_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$current}` (
            `season_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `rating` DECIMAL(14,6) NOT NULL,
            `matches_played` INT UNSIGNED NOT NULL DEFAULT 0,
            `last_event_id` BIGINT UNSIGNED NULL,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`season_id`, `player_id`),
            KEY `idx_elo_current_player` (`player_id`, `updated_at`),
            CONSTRAINT `{$prefix}fk_elo_current_season` FOREIGN KEY (`season_id`) REFERENCES `{$seasons}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_current_player` FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_elo_current_event` FOREIGN KEY (`last_event_id`) REFERENCES `{$events}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
