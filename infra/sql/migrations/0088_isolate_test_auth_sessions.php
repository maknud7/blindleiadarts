<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    if ($prefix !== 'bd_test_') {
        return;
    }

    $sessions = $prefix . 'auth_sessions';
    $localUsers = $prefix . 'user_accounts';

    // TEST authentication uses canonical PROD credentials but must never create
    // or refresh PROD sessions. Keep session rows local to bd_test_ and remove
    // the obsolete FK that required a shadow bd_test_user_accounts row.
    $mysqli->query("DELETE FROM `{$sessions}`");

    $stmt = $mysqli->prepare(
        'SELECT CONSTRAINT_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND REFERENCED_TABLE_NAME = ?
            AND REFERENCED_COLUMN_NAME = "id"'
    );
    $stmt->bind_param('ss', $sessions, $localUsers);
    $stmt->execute();
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();

    foreach ($rows as $row) {
        $constraint = (string) ($row['CONSTRAINT_NAME'] ?? '');
        if ($constraint === '' || !preg_match('/^[A-Za-z0-9_]+$/', $constraint)) {
            throw new RuntimeException('Invalid TEST auth session foreign-key name.');
        }
        $mysqli->query("ALTER TABLE `{$sessions}` DROP FOREIGN KEY `{$constraint}`");
    }

    $remaining = $mysqli->prepare(
        'SELECT COUNT(*) AS c
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND REFERENCED_TABLE_NAME IS NOT NULL'
    );
    $remaining->bind_param('s', $sessions);
    $remaining->execute();
    $count = (int) ($remaining->get_result()->fetch_assoc()['c'] ?? 0);
    $remaining->close();

    if ($count !== 0) {
        throw new RuntimeException('TEST auth_sessions still has an identity foreign key after isolation.');
    }

    fwrite(STDOUT, "0088: TEST auth sessions isolated in bd_test_auth_sessions.\n");
};
