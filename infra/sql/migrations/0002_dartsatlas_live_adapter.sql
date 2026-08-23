CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}live_match_state` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `external_system` VARCHAR(50) NOT NULL DEFAULT 'dartsatlas',
    `external_match_id` VARCHAR(150) NOT NULL,
    `board_label` VARCHAR(120) DEFAULT NULL,
    `live_status` VARCHAR(40) NOT NULL DEFAULT 'unknown',
    `player_a_legs` INT DEFAULT NULL,
    `player_b_legs` INT DEFAULT NULL,
    `player_a_remaining` INT DEFAULT NULL,
    `player_b_remaining` INT DEFAULT NULL,
    `player_a_average` DECIMAL(7,2) DEFAULT NULL,
    `player_b_average` DECIMAL(7,2) DEFAULT NULL,
    `player_a_first9` DECIMAL(7,2) DEFAULT NULL,
    `player_b_first9` DECIMAL(7,2) DEFAULT NULL,
    `broadcast_url` VARCHAR(500) DEFAULT NULL,
    `stats_json` JSON DEFAULT NULL,
    `payload_hash` CHAR(64) DEFAULT NULL,
    `last_observed_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_live_match_state_match_id` (`match_id`),
    UNIQUE KEY `uniq_live_match_state_external` (`external_system`, `external_match_id`),
    KEY `idx_live_match_state_status` (`live_status`),
    KEY `idx_live_match_state_observed` (`last_observed_at`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_live_match_state_match_id`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}connector_state` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `external_system` VARCHAR(50) NOT NULL,
    `state_key` VARCHAR(160) NOT NULL,
    `state_value` LONGTEXT DEFAULT NULL,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_connector_state` (`external_system`, `state_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
