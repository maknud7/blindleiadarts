<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $clubs = $prefix . 'clubs';
    $tournaments = $prefix . 'tournaments';
    $checkin = $prefix . 'club_checkin_settings';

    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $stmt = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
        $stmt->bind_param('ss', $table, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    foreach ([
        'billing_mode' => "ENUM('free','stripe') NOT NULL DEFAULT 'free' AFTER `logo_url`",
        'tournament_fee_ore' => "INT UNSIGNED NOT NULL DEFAULT 0 AFTER `billing_mode`",
        'stripe_customer_id' => "VARCHAR(255) NULL AFTER `tournament_fee_ore`",
    ] as $column => $definition) {
        if (!$columnExists($mysqli, $clubs, $column)) {
            $mysqli->query("ALTER TABLE `{$clubs}` ADD COLUMN `{$column}` {$definition}");
        }
    }

    foreach ([
        'actual_started_at' => "DATETIME NULL AFTER `start_at`",
        'billing_status' => "ENUM('waived','pending','paid','refunded') NOT NULL DEFAULT 'waived' AFTER `end_at`",
        'billing_amount_ore' => "INT UNSIGNED NOT NULL DEFAULT 0 AFTER `billing_status`",
        'stripe_checkout_session_id' => "VARCHAR(255) NULL AFTER `billing_amount_ore`",
    ] as $column => $definition) {
        if (!$columnExists($mysqli, $tournaments, $column)) {
            $mysqli->query("ALTER TABLE `{$tournaments}` ADD COLUMN `{$column}` {$definition}");
        }
    }

    // Existing started tournaments must stay closed after the policy change. For
    // historical rows where exact start-click time is unknown, planned start is
    // the safest deterministic backfill.
    $mysqli->query(
        "UPDATE `{$tournaments}`
         SET actual_started_at=COALESCE(actual_started_at,start_at)
         WHERE actual_started_at IS NULL AND status IN ('in_progress','completed','archived') AND start_at IS NOT NULL"
    );

    // Canonical timing policy: registration opens 6d23h (=167h) before planned
    // start; check-in opens 2h before. Both close only when Start is pressed.
    // checkin_closes_at uses an internal far-future sentinel until explicit start
    // because the existing check-in runtime expects a concrete closing datetime.
    $mysqli->query(
        "UPDATE `{$tournaments}`
         SET registration_opens_at=CASE WHEN start_at IS NULL THEN NULL ELSE DATE_SUB(start_at, INTERVAL 167 HOUR) END,
             registration_closes_at=actual_started_at,
             checkin_opens_at=CASE WHEN start_at IS NULL THEN NULL ELSE DATE_SUB(start_at, INTERVAL 2 HOUR) END,
             checkin_closes_at=COALESCE(actual_started_at,'2099-12-31 23:59:59')"
    );

    // Keep legacy club defaults aligned for old readers. Timing is no longer
    // configurable in the product; tournament-level derived values are canonical.
    $tableStmt = $mysqli->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1');
    $tableStmt->bind_param('s', $checkin);
    $tableStmt->execute();
    $hasCheckin = $tableStmt->get_result()->fetch_assoc() !== null;
    $tableStmt->close();
    if ($hasCheckin) {
        $mysqli->query("UPDATE `{$checkin}` SET opens_minutes_before_start=120, closes_minutes_after_start=0");
    }
};
