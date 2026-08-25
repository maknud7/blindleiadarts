<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $visits = $prefix . 'visits';

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

    if (!$columnExists($mysqli, $visits, 'request_key')) {
        $mysqli->query("ALTER TABLE `{$visits}` ADD COLUMN `request_key` VARCHAR(80) NULL AFTER `remaining_after`");
    }
    if (!$indexExists($mysqli, $visits, 'uniq_visits_request_key')) {
        $mysqli->query("ALTER TABLE `{$visits}` ADD UNIQUE KEY `uniq_visits_request_key` (`request_key`)");
    }
};
