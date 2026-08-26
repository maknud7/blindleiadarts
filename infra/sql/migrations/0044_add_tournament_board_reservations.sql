CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}tournament_board_reservations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tournament_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `reserved_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `activates_at` DATETIME NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_board_reservation_kiosk` (`kiosk_id`),
    UNIQUE KEY `uniq_board_reservation_match` (`match_id`),
    KEY `idx_board_reservation_tournament` (`tournament_id`),
    KEY `idx_board_reservation_activates` (`activates_at`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_board_reservation_tournament` FOREIGN KEY (`tournament_id`) REFERENCES `{{TABLE_PREFIX}}tournaments` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_board_reservation_kiosk` FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_board_reservation_match` FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
