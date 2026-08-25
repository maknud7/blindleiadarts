<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $tournaments = $prefix . 'tournaments';
    $users = $prefix . 'user_accounts';
    $summaries = $prefix . 'tournament_summaries';

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$summaries}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `title` VARCHAR(180) NOT NULL,
            `body_text` MEDIUMTEXT NOT NULL,
            `status` ENUM('draft','published') NOT NULL DEFAULT 'draft',
            `published_at` DATETIME NULL,
            `created_by_user_account_id` BIGINT UNSIGNED NULL,
            `updated_by_user_account_id` BIGINT UNSIGNED NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_tournament_summary_tournament` (`tournament_id`),
            KEY `idx_tournament_summaries_status` (`status`, `published_at`),
            CONSTRAINT `{$prefix}fk_tournament_summaries_tournament`
                FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_tournament_summaries_created_by`
                FOREIGN KEY (`created_by_user_account_id`) REFERENCES `{$users}` (`id`) ON DELETE SET NULL,
            CONSTRAINT `{$prefix}fk_tournament_summaries_updated_by`
                FOREIGN KEY (`updated_by_user_account_id`) REFERENCES `{$users}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
