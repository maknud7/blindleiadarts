CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}tournament_kiosks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tournament_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `sort_order` INT UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_tournament_kiosk` (`tournament_id`, `kiosk_id`),
    KEY `idx_tournament_kiosks_tournament_id` (`tournament_id`),
    KEY `idx_tournament_kiosks_kiosk_id` (`kiosk_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournament_kiosks_tournament_id` FOREIGN KEY (`tournament_id`) REFERENCES `{{TABLE_PREFIX}}tournaments` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournament_kiosks_kiosk_id` FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
