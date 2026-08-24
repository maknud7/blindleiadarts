<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $users = $prefix . 'user_accounts';
    $profiles = $prefix . 'member_profiles';
    $players = $prefix . 'players';
    $clubs = $prefix . 'clubs';
    $clubRoles = $prefix . 'club_user_roles';
    $globalRoles = $prefix . 'global_user_roles';

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

    $constraintExists = static function (mysqli $db, string $table, string $constraint): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $table, $constraint);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    if (!$columnExists($mysqli, $users, 'player_id')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `player_id` BIGINT UNSIGNED NULL AFTER `display_name`");
    }

    $playerIndex = 'uniq_user_accounts_player';
    if (!$indexExists($mysqli, $users, $playerIndex)) {
        $mysqli->query("ALTER TABLE `{$users}` ADD UNIQUE KEY `{$playerIndex}` (`player_id`)");
    }

    $playerConstraint = $prefix . 'fk_user_accounts_player';
    if (!$constraintExists($mysqli, $users, $playerConstraint)) {
        $mysqli->query(
            "ALTER TABLE `{$users}` ADD CONSTRAINT `{$playerConstraint}` FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`)"
        );
    }

    // Replace the old member_profiles identity hop with a direct account -> player link.
    $mysqli->query(
        "UPDATE `{$users}` ua
         INNER JOIN `{$profiles}` mp ON mp.user_account_id = ua.id
         SET ua.player_id = mp.player_id
         WHERE ua.player_id IS NULL AND mp.player_id IS NOT NULL"
    );

    // Global permissions are independent of whether an account is a player/member.
    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$globalRoles}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `user_account_id` BIGINT UNSIGNED NOT NULL,
            `role` VARCHAR(64) NOT NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_global_user_role` (`user_account_id`, `role`),
            KEY `idx_global_user_roles_role` (`role`),
            CONSTRAINT `{$prefix}fk_global_user_roles_user`
                FOREIGN KEY (`user_account_id`) REFERENCES `{$users}` (`id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // Allow future club-scoped permissions without coupling them to the account type.
    $mysqli->query("ALTER TABLE `{$clubRoles}` MODIFY COLUMN `role` VARCHAR(64) NOT NULL");

    $mysqli->query(
        "INSERT IGNORE INTO `{$globalRoles}` (`user_account_id`, `role`)
         SELECT id, 'super_admin'
         FROM `{$users}`
         WHERE role = 'super_admin'"
    );

    $mysqli->query(
        "INSERT IGNORE INTO `{$clubRoles}` (`club_id`, `user_account_id`, `role`)
         SELECT p.club_id, ua.id, 'club_admin'
         FROM `{$users}` ua
         INNER JOIN `{$players}` p ON p.id = ua.player_id
         WHERE ua.role = 'club_admin' AND p.club_id IS NOT NULL"
    );

    // Members are now local in ingentingorg02. Link only names that are unique on
    // BOTH sides. Ambiguous/unmatched rows remain deliberately unlinked for admin review.
    $membersTable = 'medlemmer';
    $membersCheck = $mysqli->prepare(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
    );
    $membersCheck->bind_param('s', $membersTable);
    $membersCheck->execute();
    $membersExist = $membersCheck->get_result()->fetch_assoc() !== null;
    $membersCheck->close();

    if ($membersExist) {
        $mysqli->query('DROP TEMPORARY TABLE IF EXISTS `tmp_bdk_safe_member_links`');
        $mysqli->query(
            "CREATE TEMPORARY TABLE `tmp_bdk_safe_member_links` (
                `player_id` BIGINT UNSIGNED NOT NULL,
                `member_id` BIGINT UNSIGNED NOT NULL,
                PRIMARY KEY (`player_id`),
                UNIQUE KEY `uniq_tmp_member_id` (`member_id`)
            ) ENGINE=MEMORY"
        );

        $mysqli->query(
            "INSERT INTO `tmp_bdk_safe_member_links` (`player_id`, `member_id`)
             SELECT pg.player_id, mg.member_id
             FROM (
                 SELECT
                     MIN(id) AS player_id,
                     LOWER(TRIM(CONVERT(display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci AS normalized_name,
                     COUNT(*) AS cnt
                 FROM `{$players}`
                 WHERE member_id IS NULL
                 GROUP BY LOWER(TRIM(CONVERT(display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci
                 HAVING COUNT(*) = 1
             ) pg
             INNER JOIN (
                 SELECT
                     MIN(id) AS member_id,
                     LOWER(TRIM(CONVERT(navn USING utf8mb4))) COLLATE utf8mb4_unicode_ci AS normalized_name,
                     COUNT(*) AS cnt
                 FROM `medlemmer`
                 GROUP BY LOWER(TRIM(CONVERT(navn USING utf8mb4))) COLLATE utf8mb4_unicode_ci
                 HAVING COUNT(*) = 1
             ) mg ON mg.normalized_name = pg.normalized_name"
        );

        $mysqli->query(
            "UPDATE `{$players}` p
             INNER JOIN `tmp_bdk_safe_member_links` l ON l.player_id = p.id
             SET p.member_id = l.member_id,
                 p.member_link_source = 'exact_name',
                 p.member_linked_at = COALESCE(p.member_linked_at, NOW())
             WHERE p.member_id IS NULL"
        );

        $mysqli->query('DROP TEMPORARY TABLE IF EXISTS `tmp_bdk_safe_member_links`');
    }
};
