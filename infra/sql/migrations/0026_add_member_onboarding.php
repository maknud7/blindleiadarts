<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $users = $prefix . 'user_accounts';
    $players = $prefix . 'players';
    $sessions = $prefix . 'auth_sessions';
    $clubRoles = $prefix . 'club_user_roles';
    $globalRoles = $prefix . 'global_user_roles';
    $invitations = $prefix . 'user_onboarding_invitations';

    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $indexExists = static function (mysqli $db, string $table, string $index): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $index);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    if (!$columnExists($mysqli, $users, 'member_id')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `member_id` BIGINT UNSIGNED NULL AFTER `player_id`");
    }
    if (!$columnExists($mysqli, $users, 'account_status')) {
        $mysqli->query(
            "ALTER TABLE `{$users}` ADD COLUMN `account_status` VARCHAR(20) NOT NULL DEFAULT 'active' AFTER `profile_notes`"
        );
    }
    if (!$columnExists($mysqli, $users, 'invited_at')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `invited_at` DATETIME NULL AFTER `account_status`");
    }
    if (!$columnExists($mysqli, $users, 'claimed_at')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `claimed_at` DATETIME NULL AFTER `invited_at`");
    }

    // A password does not exist until an account has actually been claimed.
    $mysqli->query("ALTER TABLE `{$users}` MODIFY COLUMN `password_hash` VARCHAR(255) NULL");

    // Link account directly to the durable membership identity where the existing
    // player link resolves to exactly one account for that member.
    $mysqli->query('DROP TEMPORARY TABLE IF EXISTS `tmp_bdk_account_members`');
    $mysqli->query(
        "CREATE TEMPORARY TABLE `tmp_bdk_account_members` (
            `user_account_id` BIGINT UNSIGNED NOT NULL,
            `member_id` BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (`user_account_id`),
            UNIQUE KEY `uniq_tmp_account_member` (`member_id`)
        ) ENGINE=MEMORY"
    );
    $mysqli->query(
        "INSERT INTO `tmp_bdk_account_members` (`user_account_id`, `member_id`)
         SELECT MIN(ua.id), p.member_id
         FROM `{$users}` ua
         INNER JOIN `{$players}` p ON p.id=ua.player_id
         WHERE p.member_id IS NOT NULL
         GROUP BY p.member_id
         HAVING COUNT(DISTINCT ua.id)=1"
    );
    $mysqli->query(
        "UPDATE `{$users}` ua
         INNER JOIN `tmp_bdk_account_members` x ON x.user_account_id=ua.id
         SET ua.member_id=x.member_id
         WHERE ua.member_id IS NULL"
    );
    $mysqli->query('DROP TEMPORARY TABLE IF EXISTS `tmp_bdk_account_members`');

    if (!$indexExists($mysqli, $users, 'uniq_user_accounts_member')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD UNIQUE KEY `uniq_user_accounts_member` (`member_id`)");
    }
    if (!$indexExists($mysqli, $users, 'idx_user_accounts_status')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD KEY `idx_user_accounts_status` (`account_status`)");
    }

    // Existing accounts with actual use or permissions remain active. Seeded player
    // accounts that have never been used become unclaimed placeholders without a password.
    $mysqli->query(
        "UPDATE `{$users}` ua
         SET ua.account_status='unclaimed',
             ua.is_active=0,
             ua.password_hash=NULL,
             ua.claimed_at=NULL
         WHERE ua.last_login_at IS NULL
           AND ua.role='player'
           AND NOT EXISTS (SELECT 1 FROM `{$sessions}` s WHERE s.user_account_id=ua.id)
           AND NOT EXISTS (SELECT 1 FROM `{$globalRoles}` gr WHERE gr.user_account_id=ua.id)
           AND NOT EXISTS (SELECT 1 FROM `{$clubRoles}` cr WHERE cr.user_account_id=ua.id)"
    );
    $mysqli->query(
        "UPDATE `{$users}`
         SET account_status='active',
             is_active=1,
             claimed_at=COALESCE(claimed_at, last_login_at, created_at)
         WHERE account_status <> 'unclaimed'"
    );

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$invitations}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `user_account_id` BIGINT UNSIGNED NOT NULL,
            `member_id` BIGINT UNSIGNED NOT NULL,
            `token_hash` CHAR(64) NOT NULL,
            `created_by_user_account_id` BIGINT UNSIGNED NULL,
            `expires_at` DATETIME NOT NULL,
            `used_at` DATETIME NULL,
            `revoked_at` DATETIME NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_user_onboarding_token` (`token_hash`),
            KEY `idx_user_onboarding_account` (`user_account_id`, `used_at`, `revoked_at`),
            KEY `idx_user_onboarding_member` (`member_id`),
            KEY `idx_user_onboarding_expires` (`expires_at`),
            CONSTRAINT `{$prefix}fk_onboarding_account`
                FOREIGN KEY (`user_account_id`) REFERENCES `{$users}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_onboarding_created_by`
                FOREIGN KEY (`created_by_user_account_id`) REFERENCES `{$users}` (`id`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
