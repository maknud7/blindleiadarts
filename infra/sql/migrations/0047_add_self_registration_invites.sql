CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}self_registration_invites` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `created_by_user_account_id` BIGINT UNSIGNED DEFAULT NULL,
    `expires_at` DATETIME NOT NULL,
    `first_name` VARCHAR(100) DEFAULT NULL,
    `last_name` VARCHAR(120) DEFAULT NULL,
    `email` VARCHAR(255) DEFAULT NULL,
    `password_hash` VARCHAR(255) DEFAULT NULL,
    `submitted_at` DATETIME DEFAULT NULL,
    `approved_member_id` BIGINT UNSIGNED DEFAULT NULL,
    `approved_by_user_account_id` BIGINT UNSIGNED DEFAULT NULL,
    `approved_at` DATETIME DEFAULT NULL,
    `revoked_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_self_registration_token` (`token_hash`),
    KEY `idx_self_registration_club` (`club_id`, `submitted_at`, `approved_at`, `revoked_at`),
    KEY `idx_self_registration_expires` (`expires_at`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_self_registration_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
