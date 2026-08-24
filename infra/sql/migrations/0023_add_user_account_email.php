<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $users = $prefix . 'user_accounts';
    $profiles = $prefix . 'member_profiles';

    $columnCheck = $mysqli->prepare(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
    );
    $column = 'email';
    $columnCheck->bind_param('ss', $users, $column);
    $columnCheck->execute();
    $hasEmail = $columnCheck->get_result()->fetch_assoc() !== null;
    $columnCheck->close();

    if (!$hasEmail) {
        $mysqli->query("ALTER TABLE `{$users}` ADD COLUMN `email` VARCHAR(255) DEFAULT NULL AFTER `username`");
    }

    // Backfill only contact e-mails that are valid, unique and clearly personal.
    // The legacy seed used one shared club address for every demo profile; duplicate
    // values are intentionally ignored here and never become account logins.
    $result = $mysqli->query(
        "SELECT LOWER(TRIM(mp.contact_email)) AS email, COUNT(*) AS cnt
         FROM `{$profiles}` mp
         WHERE mp.contact_email IS NOT NULL AND TRIM(mp.contact_email) <> ''
         GROUP BY LOWER(TRIM(mp.contact_email))
         HAVING COUNT(*) = 1"
    );
    $uniqueEmails = [];
    while ($row = $result->fetch_assoc()) {
        $email = (string) ($row['email'] ?? '');
        if (filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $uniqueEmails[] = $email;
        }
    }
    $result->free();

    $select = $mysqli->prepare(
        "SELECT ua.id
         FROM `{$users}` ua
         JOIN `{$profiles}` mp ON mp.user_account_id = ua.id
         WHERE LOWER(TRIM(mp.contact_email)) = ? AND ua.email IS NULL
         LIMIT 1"
    );
    $update = $mysqli->prepare("UPDATE `{$users}` SET email = ? WHERE id = ? AND email IS NULL");
    foreach ($uniqueEmails as $email) {
        $select->bind_param('s', $email);
        $select->execute();
        $row = $select->get_result()->fetch_assoc();
        if ($row) {
            $id = (int) $row['id'];
            $update->bind_param('si', $email, $id);
            $update->execute();
        }
    }
    $select->close();
    $update->close();

    $index = 'uniq_user_accounts_email';
    $indexCheck = $mysqli->prepare(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1'
    );
    $indexCheck->bind_param('ss', $users, $index);
    $indexCheck->execute();
    $hasIndex = $indexCheck->get_result()->fetch_assoc() !== null;
    $indexCheck->close();

    if (!$hasIndex) {
        $mysqli->query("ALTER TABLE `{$users}` ADD UNIQUE KEY `{$index}` (`email`)");
    }
};
