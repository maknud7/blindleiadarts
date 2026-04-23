CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}screen_devices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `label` VARCHAR(150) DEFAULT NULL,
    `access_code` VARCHAR(32) NOT NULL,
    `access_token` VARCHAR(96) NOT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `last_connected_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_screen_devices_access_code` (`access_code`),
    UNIQUE KEY `uniq_screen_devices_access_token` (`access_token`),
    KEY `idx_screen_devices_club_id` (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_screen_devices_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
