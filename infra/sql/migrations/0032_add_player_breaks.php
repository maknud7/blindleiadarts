<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'tournament_player_breaks';
    $tournaments = $prefix . 'tournaments';
    $players = $prefix . 'players';
    $matches = $prefix . 'matches';

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$table}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `after_match_id` BIGINT UNSIGNED NULL,
            `status` ENUM('scheduled','active','completed') NOT NULL,
            `requested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `starts_at` DATETIME NULL,
            `ends_at` DATETIME NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_player_breaks_tournament_status` (`tournament_id`, `status`, `ends_at`),
            KEY `idx_player_breaks_player_status` (`player_id`, `status`, `ends_at`),
            KEY `idx_player_breaks_after_match` (`after_match_id`),
            CONSTRAINT `{$prefix}fk_player_breaks_tournament`
                FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_player_breaks_player`
                FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_player_breaks_match`
                FOREIGN KEY (`after_match_id`) REFERENCES `{$matches}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};