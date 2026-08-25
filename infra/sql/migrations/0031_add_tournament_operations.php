<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $table = $prefix . 'tournaments';

    $columnExists = static function (mysqli $db, string $tableName, string $column): bool {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1'
        );
        $stmt->bind_param('ss', $tableName, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    if (!$columnExists($mysqli, $table, 'auto_assign_enabled')) {
        $mysqli->query(
            "ALTER TABLE `{$table}` ADD COLUMN `auto_assign_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `elo_enabled`"
        );
    }
};
