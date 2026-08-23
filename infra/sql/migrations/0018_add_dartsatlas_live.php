<?php

declare(strict_types=1);

return static function (mysqli $db, string $prefix): void {
    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $statement = $db->prepare(
            'SELECT COUNT(*) AS cnt
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $statement->bind_param('ss', $table, $column);
        $statement->execute();
        $exists = (int) ($statement->get_result()->fetch_assoc()['cnt'] ?? 0) > 0;
        $statement->close();
        return $exists;
    };

    $indexExists = static function (mysqli $db, string $table, string $index): bool {
        $statement = $db->prepare(
            'SELECT COUNT(*) AS cnt
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?'
        );
        $statement->bind_param('ss', $table, $index);
        $statement->execute();
        $exists = (int) ($statement->get_result()->fetch_assoc()['cnt'] ?? 0) > 0;
        $statement->close();
        return $exists;
    };

    $players = $prefix . 'players';
    $matches = $prefix . 'matches';

    if (!$columnExists($db, $players, 'member_id')) {
        $db->query("ALTER TABLE `{$players}` ADD COLUMN `member_id` BIGINT UNSIGNED DEFAULT NULL AFTER `club_id`");
    }
    if (!$columnExists($db, $players, 'member_link_source')) {
        $db->query("ALTER TABLE `{$players}` ADD COLUMN `member_link_source` VARCHAR(50) DEFAULT NULL AFTER `member_id`");
    }
    if (!$columnExists($db, $players, 'member_linked_at')) {
        $db->query("ALTER TABLE `{$players}` ADD COLUMN `member_linked_at` DATETIME DEFAULT NULL AFTER `member_link_source`");
    }
    if (!$indexExists($db, $players, 'uniq_players_member_id')) {
        $db->query("ALTER TABLE `{$players}` ADD UNIQUE KEY `uniq_players_member_id` (`member_id`)");
    }
    if (!$columnExists($db, $matches, 'provider_metadata')) {
        $db->query("ALTER TABLE `{$matches}` ADD COLUMN `provider_metadata` JSON DEFAULT NULL AFTER `bracket_label`");
    }

    $connectorResources = $prefix . 'connector_resources';
    $matchStatistics = $prefix . 'match_statistics';
    $liveStates = $prefix . 'live_match_states';

    $db->query(
        "CREATE TABLE IF NOT EXISTS `{$connectorResources}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `external_system` VARCHAR(50) NOT NULL,
            `resource_type` VARCHAR(50) NOT NULL,
            `external_id` VARCHAR(180) NOT NULL,
            `parent_external_id` VARCHAR(180) DEFAULT NULL,
            `source_url` VARCHAR(500) NOT NULL,
            `etag` VARCHAR(255) DEFAULT NULL,
            `last_modified` VARCHAR(255) DEFAULT NULL,
            `content_hash` CHAR(64) DEFAULT NULL,
            `last_http_status` SMALLINT UNSIGNED DEFAULT NULL,
            `payload_json` JSON DEFAULT NULL,
            `first_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `last_changed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_connector_resource` (`external_system`, `resource_type`, `external_id`),
            KEY `idx_connector_resources_parent` (`external_system`, `parent_external_id`),
            KEY `idx_connector_resources_seen` (`external_system`, `last_seen_at`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $db->query(
        "CREATE TABLE IF NOT EXISTS `{$matchStatistics}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `match_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `legs_won` SMALLINT UNSIGNED DEFAULT NULL,
            `average` DECIMAL(7,2) DEFAULT NULL,
            `first_nine_average` DECIMAL(7,2) DEFAULT NULL,
            `darts_thrown` SMALLINT UNSIGNED DEFAULT NULL,
            `checkout_hits` SMALLINT UNSIGNED DEFAULT NULL,
            `checkout_attempts` SMALLINT UNSIGNED DEFAULT NULL,
            `highest_checkout` SMALLINT UNSIGNED DEFAULT NULL,
            `score_100_plus` SMALLINT UNSIGNED DEFAULT NULL,
            `score_140_plus` SMALLINT UNSIGNED DEFAULT NULL,
            `score_180` SMALLINT UNSIGNED DEFAULT NULL,
            `provider_metadata` JSON DEFAULT NULL,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_match_statistics_player` (`match_id`, `player_id`),
            KEY `idx_match_statistics_player_id` (`player_id`),
            CONSTRAINT `{$prefix}fk_match_statistics_match_id`
                FOREIGN KEY (`match_id`) REFERENCES `{$matches}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_match_statistics_player_id`
                FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $db->query(
        "CREATE TABLE IF NOT EXISTS `{$liveStates}` (
            `match_id` BIGINT UNSIGNED NOT NULL,
            `player_a_score` SMALLINT UNSIGNED DEFAULT NULL,
            `player_b_score` SMALLINT UNSIGNED DEFAULT NULL,
            `player_a_legs` SMALLINT UNSIGNED DEFAULT NULL,
            `player_b_legs` SMALLINT UNSIGNED DEFAULT NULL,
            `current_leg` SMALLINT UNSIGNED DEFAULT NULL,
            `throwing_player_id` BIGINT UNSIGNED DEFAULT NULL,
            `provider_status` VARCHAR(50) DEFAULT NULL,
            `provider_updated_at` DATETIME DEFAULT NULL,
            `provider_metadata` JSON DEFAULT NULL,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`match_id`),
            KEY `idx_live_match_states_throwing_player_id` (`throwing_player_id`),
            CONSTRAINT `{$prefix}fk_live_match_states_match_id`
                FOREIGN KEY (`match_id`) REFERENCES `{$matches}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_live_match_states_throwing_player_id`
                FOREIGN KEY (`throwing_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
