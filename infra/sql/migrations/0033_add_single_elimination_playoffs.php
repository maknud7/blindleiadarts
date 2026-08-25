<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $playoffs = $prefix . 'tournament_playoffs';
    $entries = $prefix . 'tournament_playoff_entries';
    $nodes = $prefix . 'tournament_playoff_nodes';
    $tournaments = $prefix . 'tournaments';
    $players = $prefix . 'players';
    $groups = $prefix . 'tournament_groups';
    $matches = $prefix . 'matches';

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$playoffs}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `format` ENUM('single_elimination') NOT NULL DEFAULT 'single_elimination',
            `qualifiers_per_group` TINYINT UNSIGNED NOT NULL,
            `bracket_size` TINYINT UNSIGNED NOT NULL,
            `best_of_legs` TINYINT UNSIGNED NOT NULL,
            `status` ENUM('ready','in_progress','completed') NOT NULL DEFAULT 'ready',
            `champion_player_id` BIGINT UNSIGNED NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_tournament_playoff` (`tournament_id`),
            KEY `idx_tournament_playoffs_status` (`status`),
            KEY `idx_tournament_playoffs_champion` (`champion_player_id`),
            CONSTRAINT `{$prefix}fk_tournament_playoffs_tournament`
                FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_playoffs_champion`
                FOREIGN KEY (`champion_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$entries}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `playoff_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `seed_number` SMALLINT UNSIGNED NOT NULL,
            `source_group_id` BIGINT UNSIGNED NOT NULL,
            `source_group_position` TINYINT UNSIGNED NOT NULL,
            `source_points` SMALLINT NOT NULL DEFAULT 0,
            `source_leg_diff` SMALLINT NOT NULL DEFAULT 0,
            `source_legs_won` SMALLINT NOT NULL DEFAULT 0,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_playoff_entry_player` (`playoff_id`, `player_id`),
            UNIQUE KEY `uniq_playoff_entry_seed` (`playoff_id`, `seed_number`),
            KEY `idx_playoff_entries_group` (`source_group_id`),
            CONSTRAINT `{$prefix}fk_playoff_entries_playoff`
                FOREIGN KEY (`playoff_id`) REFERENCES `{$playoffs}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_playoff_entries_player`
                FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_playoff_entries_group`
                FOREIGN KEY (`source_group_id`) REFERENCES `{$groups}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$nodes}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `playoff_id` BIGINT UNSIGNED NOT NULL,
            `round_number` SMALLINT UNSIGNED NOT NULL,
            `position` SMALLINT UNSIGNED NOT NULL,
            `round_label` VARCHAR(120) NOT NULL,
            `player_a_id` BIGINT UNSIGNED NULL,
            `player_b_id` BIGINT UNSIGNED NULL,
            `match_id` BIGINT UNSIGNED NULL,
            `winner_player_id` BIGINT UNSIGNED NULL,
            `status` ENUM('waiting','ready','bye','completed') NOT NULL DEFAULT 'waiting',
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_playoff_node_position` (`playoff_id`, `round_number`, `position`),
            UNIQUE KEY `uniq_playoff_node_match` (`match_id`),
            KEY `idx_playoff_nodes_winner` (`winner_player_id`),
            CONSTRAINT `{$prefix}fk_playoff_nodes_playoff`
                FOREIGN KEY (`playoff_id`) REFERENCES `{$playoffs}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_playoff_nodes_player_a`
                FOREIGN KEY (`player_a_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL,
            CONSTRAINT `{$prefix}fk_playoff_nodes_player_b`
                FOREIGN KEY (`player_b_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL,
            CONSTRAINT `{$prefix}fk_playoff_nodes_match`
                FOREIGN KEY (`match_id`) REFERENCES `{$matches}` (`id`) ON DELETE SET NULL,
            CONSTRAINT `{$prefix}fk_playoff_nodes_winner`
                FOREIGN KEY (`winner_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
