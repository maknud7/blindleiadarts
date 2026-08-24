CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}club_user_roles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `user_account_id` BIGINT UNSIGNED NOT NULL,
    `role` ENUM('club_admin') NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_club_user_role` (`club_id`, `user_account_id`, `role`),
    KEY `idx_club_user_roles_user` (`user_account_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_club_user_roles_club` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_club_user_roles_user` FOREIGN KEY (`user_account_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `{{TABLE_PREFIX}}club_user_roles` (`club_id`, `user_account_id`, `role`)
SELECT p.club_id, ua.id, 'club_admin'
FROM `{{TABLE_PREFIX}}user_accounts` ua
INNER JOIN `{{TABLE_PREFIX}}member_profiles` mp ON mp.user_account_id = ua.id
INNER JOIN `{{TABLE_PREFIX}}players` p ON p.id = mp.player_id
WHERE ua.role = 'club_admin' AND p.club_id IS NOT NULL;
