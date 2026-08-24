<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $users = $prefix . 'user_accounts';
    $profiles = $prefix . 'member_profiles';

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

    $objectType = static function (mysqli $db, string $name): ?string {
        $stmt = $db->prepare(
            'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
        );
        $stmt->bind_param('s', $name);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row !== null ? (string) $row['TABLE_TYPE'] : null;
    };

    if (!$columnExists($mysqli, $users, 'contact_phone')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `contact_phone` VARCHAR(50) NULL AFTER `email`");
    }
    if (!$columnExists($mysqli, $users, 'profile_notes')) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `profile_notes` TEXT NULL AFTER `contact_phone`");
    }

    $profileType = $objectType($mysqli, $profiles);
    if ($profileType === 'BASE TABLE') {
        // 0024 must already have made account -> player the canonical identity link.
        $mismatch = (int) ($mysqli->query(
            "SELECT COUNT(*) c
             FROM `{$profiles}` mp
             INNER JOIN `{$users}` ua ON ua.id=mp.user_account_id
             WHERE mp.player_id IS NOT NULL
               AND NOT (ua.player_id <=> mp.player_id)"
        )->fetch_assoc()['c'] ?? 0);
        if ($mismatch > 0) {
            throw new RuntimeException('member_profiles still contains player links that differ from user_accounts.player_id');
        }

        // Preserve the only profile fields that are not already canonical elsewhere.
        $mysqli->query(
            "UPDATE `{$users}` ua
             INNER JOIN `{$profiles}` mp ON mp.user_account_id=ua.id
             SET ua.contact_phone = CASE
                    WHEN (ua.contact_phone IS NULL OR TRIM(ua.contact_phone)='')
                         AND mp.contact_phone IS NOT NULL AND TRIM(mp.contact_phone)<>''
                    THEN mp.contact_phone ELSE ua.contact_phone END,
                 ua.profile_notes = CASE
                    WHEN (ua.profile_notes IS NULL OR TRIM(ua.profile_notes)='')
                         AND mp.notes IS NOT NULL AND TRIM(mp.notes)<>''
                    THEN mp.notes ELSE ua.profile_notes END"
        );

        // Email and player_id are already stored canonically on user_accounts.
        // Remove the duplicated physical storage once preservation is complete.
        $mysqli->query("DROP TABLE `{$profiles}`");
    } elseif ($profileType === 'VIEW') {
        $mysqli->query("DROP VIEW `{$profiles}`");
    }

    // Transitional compatibility only: old read queries can keep using the old
    // object name, but it no longer stores any rows of its own.
    $mysqli->query(
        "CREATE OR REPLACE VIEW `{$profiles}` AS
         SELECT
             ua.id AS id,
             ua.id AS user_account_id,
             ua.player_id AS player_id,
             ua.email AS contact_email,
             ua.contact_phone AS contact_phone,
             ua.profile_notes AS notes,
             ua.created_at AS created_at,
             ua.updated_at AS updated_at
         FROM `{$users}` ua"
    );
};
