<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    // Physical boards are canonical in production. bd_test_kiosks is retained only as
    // an internal runtime binding because match tables currently store a kiosk_id.
    // It is not a second board registry and rows are synced from the physical board
    // when explicit kiosk test mode is activated.
    if ($prefix !== 'bd_test_') {
        return;
    }

    $table = $prefix . 'kiosks';
    $column = 'source_kiosk_id';
    $stmt = $mysqli->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    if (!$exists) {
        $mysqli->query("ALTER TABLE `{$table}` ADD COLUMN `source_kiosk_id` BIGINT UNSIGNED NULL AFTER `id`");
    }

    $index = 'uniq_test_kiosk_source';
    $stmt = $mysqli->prepare('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1');
    $stmt->bind_param('ss', $table, $index);
    $stmt->execute();
    $hasIndex = $stmt->get_result()->fetch_assoc() !== null;
    $stmt->close();
    if (!$hasIndex) {
        $mysqli->query("ALTER TABLE `{$table}` ADD UNIQUE KEY `{$index}` (`source_kiosk_id`)");
    }
};