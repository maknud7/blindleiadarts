<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'player_member_link_audit';
    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$table}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `club_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `player_display_name` VARCHAR(150) NOT NULL,
            `member_id` BIGINT UNSIGNED NOT NULL,
            `member_name` VARCHAR(150) NOT NULL,
            `actor_user_account_id` BIGINT UNSIGNED NULL,
            `link_source` VARCHAR(50) NOT NULL DEFAULT 'club_admin_manual',
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_player_member_link_audit_club` (`club_id`,`created_at`),
            KEY `idx_player_member_link_audit_player` (`player_id`),
            KEY `idx_player_member_link_audit_member` (`member_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
