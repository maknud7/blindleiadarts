<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    // Only the deployed test domain points at a different identity prefix.
    // Production uses bd_prod_ for both domain and identity, so its referential
    // integrity must remain intact.
    if ($prefix !== 'bd_test_') {
        return;
    }

    $users = $prefix . 'user_accounts';

    // Authentication and permission tables in bd_test_ remain internally constrained
    // for isolated CI smoke tests. Runtime test authentication does not use them.
    // Environment-specific domain rows may be written by a shared bd_prod_ account,
    // so their actor/audit references must be soft numeric IDs.
    $identityTables = [
        $prefix . 'auth_sessions',
        $prefix . 'club_user_roles',
        $prefix . 'global_user_roles',
        $prefix . 'user_onboarding_invitations',
    ];

    $stmt = $mysqli->prepare(
        "SELECT DISTINCT TABLE_NAME, CONSTRAINT_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_SCHEMA=DATABASE()
            AND REFERENCED_TABLE_SCHEMA=DATABASE()
            AND REFERENCED_TABLE_NAME=?
            AND CONSTRAINT_NAME<>'PRIMARY'
          ORDER BY TABLE_NAME, CONSTRAINT_NAME"
    );
    $stmt->bind_param('s', $users);
    $stmt->execute();
    $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();

    foreach ($rows as $row) {
        $table = (string) ($row['TABLE_NAME'] ?? '');
        $constraint = (string) ($row['CONSTRAINT_NAME'] ?? '');
        if ($table === '' || $constraint === '' || in_array($table, $identityTables, true)) {
            continue;
        }
        if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $constraint)) {
            throw new RuntimeException('Unsafe identity foreign-key metadata.');
        }

        $mysqli->query("ALTER TABLE `{$table}` DROP FOREIGN KEY `{$constraint}`");
    }
};