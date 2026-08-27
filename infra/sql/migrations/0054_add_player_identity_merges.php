<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $players = $prefix . 'players';
    $merges = $prefix . 'player_identity_merges';

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

    $constraintExists = static function (mysqli $db, string $table, string $constraint): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $constraint);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    if (!$columnExists($mysqli, $players, 'merged_into_player_id')) {
        $mysqli->query("ALTER TABLE `{$players}` ADD COLUMN `merged_into_player_id` BIGINT UNSIGNED NULL AFTER `is_active`");
    }
    if (!$columnExists($mysqli, $players, 'merged_at')) {
        $mysqli->query("ALTER TABLE `{$players}` ADD COLUMN `merged_at` DATETIME NULL AFTER `merged_into_player_id`");
    }
    if (!$indexExists($mysqli, $players, 'idx_players_merged_into')) {
        $mysqli->query("ALTER TABLE `{$players}` ADD KEY `idx_players_merged_into` (`merged_into_player_id`)");
    }

    $mergeFk = $prefix . 'fk_players_merged_into';
    if (!$constraintExists($mysqli, $players, $mergeFk)) {
        $mysqli->query(
            "ALTER TABLE `{$players}` ADD CONSTRAINT `{$mergeFk}`
             FOREIGN KEY (`merged_into_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL"
        );
    }

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$merges}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `club_id` BIGINT UNSIGNED NULL,
            `source_player_id` BIGINT UNSIGNED NOT NULL,
            `target_player_id` BIGINT UNSIGNED NOT NULL,
            `source_display_name` VARCHAR(150) NOT NULL,
            `target_display_name` VARCHAR(150) NOT NULL,
            `merged_by_user_account_id` BIGINT UNSIGNED NULL,
            `reason` VARCHAR(255) NULL,
            `summary_json` JSON NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_player_identity_merges_source` (`source_player_id`),
            KEY `idx_player_identity_merges_target` (`target_player_id`),
            KEY `idx_player_identity_merges_club` (`club_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
