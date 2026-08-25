<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $tournaments = $prefix . 'tournaments';
    $tournamentPlayers = $prefix . 'tournament_players';
    $groups = $prefix . 'tournament_groups';
    $groupPlayers = $prefix . 'tournament_group_players';
    $matches = $prefix . 'matches';

    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $indexExists = static function (mysqli $db, string $table, string $index): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $index);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    foreach ([
        'registration_opens_at' => "DATETIME NULL AFTER `end_at`",
        'registration_closes_at' => "DATETIME NULL AFTER `registration_opens_at`",
        'max_players' => "INT UNSIGNED NULL AFTER `registration_closes_at`",
        'group_count' => "SMALLINT UNSIGNED NULL AFTER `max_players`",
        'group_draw_mode' => "VARCHAR(30) NULL AFTER `group_count`",
        'group_draw_seed' => "BIGINT UNSIGNED NULL AFTER `group_draw_mode`",
        'group_drawn_at' => "DATETIME NULL AFTER `group_draw_seed`",
    ] as $column => $definition) {
        if (!$columnExists($mysqli, $tournaments, $column)) {
            $mysqli->query("ALTER TABLE `{$tournaments}` ADD COLUMN `{$column}` {$definition}");
        }
    }

    // Keep legacy values valid while adding explicit waitlist/no-show states.
    $mysqli->query(
        "ALTER TABLE `{$tournamentPlayers}` MODIFY COLUMN `status`
         ENUM('registered','waitlisted','checked_in','withdrawn','no_show','eliminated')
         NOT NULL DEFAULT 'registered'"
    );

    foreach ([
        'seed_rating' => "DECIMAL(12,4) NULL AFTER `seed`",
        'seed_rating_source' => "VARCHAR(60) NULL AFTER `seed_rating`",
        'registration_source' => "VARCHAR(30) NOT NULL DEFAULT 'player' AFTER `status`",
    ] as $column => $definition) {
        if (!$columnExists($mysqli, $tournamentPlayers, $column)) {
            $mysqli->query("ALTER TABLE `{$tournamentPlayers}` ADD COLUMN `{$column}` {$definition}");
        }
    }

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$groups}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `name` VARCHAR(80) NOT NULL,
            `sort_order` SMALLINT UNSIGNED NOT NULL,
            `draw_mode` VARCHAR(30) NOT NULL,
            `draw_seed` BIGINT UNSIGNED NOT NULL,
            `generated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_tournament_group_order` (`tournament_id`, `sort_order`),
            UNIQUE KEY `uniq_tournament_group_name` (`tournament_id`, `name`),
            CONSTRAINT `{$prefix}fk_tournament_groups_tournament`
                FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$groupPlayers}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `group_id` BIGINT UNSIGNED NOT NULL,
            `tournament_player_id` BIGINT UNSIGNED NOT NULL,
            `position` SMALLINT UNSIGNED NOT NULL,
            `seed_number` INT UNSIGNED NULL,
            `seed_rating` DECIMAL(12,4) NULL,
            `seed_rating_source` VARCHAR(60) NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_group_player` (`group_id`, `tournament_player_id`),
            UNIQUE KEY `uniq_tournament_player_group` (`tournament_player_id`),
            KEY `idx_tournament_group_players_group` (`group_id`, `position`),
            CONSTRAINT `{$prefix}fk_tournament_group_players_group`
                FOREIGN KEY (`group_id`) REFERENCES `{$groups}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_group_players_registration`
                FOREIGN KEY (`tournament_player_id`) REFERENCES `{$tournamentPlayers}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    if (!$columnExists($mysqli, $matches, 'tournament_group_id')) {
        $mysqli->query("ALTER TABLE `{$matches}` ADD COLUMN `tournament_group_id` BIGINT UNSIGNED NULL AFTER `tournament_id`");
    }
    if (!$columnExists($mysqli, $matches, 'round_number')) {
        $mysqli->query("ALTER TABLE `{$matches}` ADD COLUMN `round_number` SMALLINT UNSIGNED NULL AFTER `round_label`");
    }
    if (!$indexExists($mysqli, $matches, 'idx_matches_tournament_group_id')) {
        $mysqli->query("ALTER TABLE `{$matches}` ADD KEY `idx_matches_tournament_group_id` (`tournament_group_id`)");
    }

    $fkName = $prefix . 'fk_matches_tournament_group_id';
    $fkStmt = $mysqli->prepare(
        'SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=? LIMIT 1'
    );
    $fkStmt->bind_param('s', $fkName);
    $fkStmt->execute();
    $fkExists = $fkStmt->get_result()->fetch_assoc() !== null;
    $fkStmt->close();
    if (!$fkExists) {
        $mysqli->query(
            "ALTER TABLE `{$matches}` ADD CONSTRAINT `{$fkName}`
             FOREIGN KEY (`tournament_group_id`) REFERENCES `{$groups}` (`id`) ON DELETE SET NULL"
        );
    }
};
