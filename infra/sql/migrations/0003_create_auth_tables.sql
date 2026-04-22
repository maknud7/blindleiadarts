CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}user_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(120) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(150) NOT NULL,
    `role` ENUM('player', 'admin') NOT NULL DEFAULT 'player',
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `last_login_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_user_accounts_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}member_profiles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_account_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED DEFAULT NULL,
    `contact_email` VARCHAR(255) DEFAULT NULL,
    `contact_phone` VARCHAR(50) DEFAULT NULL,
    `notes` TEXT DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_member_profiles_user_account_id` (`user_account_id`),
    UNIQUE KEY `uniq_member_profiles_player_id` (`player_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_member_profiles_user_account_id` FOREIGN KEY (`user_account_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_member_profiles_player_id` FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}auth_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_account_id` BIGINT UNSIGNED NOT NULL,
    `session_token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME NOT NULL,
    `last_used_at` DATETIME DEFAULT NULL,
    `revoked_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_auth_sessions_session_token_hash` (`session_token_hash`),
    KEY `idx_auth_sessions_user_account_id` (`user_account_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_auth_sessions_user_account_id` FOREIGN KEY (`user_account_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
