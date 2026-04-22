CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}connector_authorizations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `provider_key` VARCHAR(50) NOT NULL,
    `authorization_type` VARCHAR(50) NOT NULL DEFAULT 'oauth',
    `external_subject_id` VARCHAR(150) DEFAULT NULL,
    `external_subject_name` VARCHAR(150) DEFAULT NULL,
    `access_token` TEXT NOT NULL,
    `refresh_token` TEXT DEFAULT NULL,
    `token_type` VARCHAR(50) DEFAULT NULL,
    `scope` TEXT DEFAULT NULL,
    `expires_at` DATETIME DEFAULT NULL,
    `payload_json` JSON DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_connector_authorizations_provider_key` (`provider_key`),
    KEY `idx_connector_authorizations_external_subject_id` (`external_subject_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
