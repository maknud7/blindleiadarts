CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_test_leases` (
    `physical_kiosk_id` BIGINT UNSIGNED NOT NULL,
    `test_kiosk_id` BIGINT UNSIGNED NOT NULL,
    `leased_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `heartbeat_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`physical_kiosk_id`),
    UNIQUE KEY `uniq_scolia_test_lease_test_kiosk` (`test_kiosk_id`),
    KEY `idx_scolia_test_lease_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
