ALTER TABLE `{{TABLE_PREFIX}}players`
    ADD COLUMN `member_id` BIGINT UNSIGNED DEFAULT NULL AFTER `club_id`,
    ADD COLUMN `member_link_method` VARCHAR(40) DEFAULT NULL AFTER `member_id`,
    ADD COLUMN `member_linked_at` DATETIME DEFAULT NULL AFTER `member_link_method`,
    ADD UNIQUE KEY `uniq_players_member_id` (`member_id`);

ALTER TABLE `{{TABLE_PREFIX}}matches`
    ADD COLUMN `legs_won_a` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `winner_player_id`,
    ADD COLUMN `legs_won_b` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `legs_won_a`,
    ADD COLUMN `provider_metadata` JSON DEFAULT NULL AFTER `legs_won_b`,
    ADD COLUMN `live_updated_at` DATETIME DEFAULT NULL AFTER `provider_metadata`;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}match_player_stats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `three_dart_average` DECIMAL(7,2) DEFAULT NULL,
    `first_nine_average` DECIMAL(7,2) DEFAULT NULL,
    `darts_thrown` INT UNSIGNED DEFAULT NULL,
    `score_100_plus` INT UNSIGNED DEFAULT NULL,
    `score_140_plus` INT UNSIGNED DEFAULT NULL,
    `score_180` INT UNSIGNED DEFAULT NULL,
    `checkout_attempts` INT UNSIGNED DEFAULT NULL,
    `checkouts_hit` INT UNSIGNED DEFAULT NULL,
    `highest_checkout` INT UNSIGNED DEFAULT NULL,
    `best_leg_darts` INT UNSIGNED DEFAULT NULL,
    `metadata_json` JSON DEFAULT NULL,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_match_player_stats` (`match_id`, `player_id`),
    KEY `idx_match_player_stats_player_id` (`player_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_match_player_stats_match_id`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_match_player_stats_player_id`
        FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}provider_snapshots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `external_system` VARCHAR(50) NOT NULL,
    `external_entity_type` VARCHAR(60) NOT NULL,
    `external_id` VARCHAR(190) NOT NULL,
    `source_url` VARCHAR(500) NOT NULL,
    `http_status` SMALLINT UNSIGNED DEFAULT NULL,
    `content_sha256` CHAR(64) NOT NULL,
    `payload` LONGTEXT NOT NULL,
    `parse_status` ENUM('fetched', 'parsed', 'partial', 'failed') NOT NULL DEFAULT 'fetched',
    `parse_error` TEXT DEFAULT NULL,
    `fetched_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `parsed_at` DATETIME DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_provider_snapshot_entity` (`external_system`, `external_entity_type`, `external_id`),
    KEY `idx_provider_snapshots_fetched_at` (`external_system`, `fetched_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
