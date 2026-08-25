<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $seasons = $prefix . 'seasons';
    $players = $prefix . 'players';

    $columnExists = static function (mysqli $db, string $table, string $column): bool {
        $stmt = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1');
        $stmt->bind_param('ss', $table, $column);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    $constraintExists = static function (mysqli $db, string $table, string $constraint): bool {
        $stmt = $db->prepare('SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=? LIMIT 1');
        $stmt->bind_param('ss', $table, $constraint);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    };

    if (!$columnExists($mysqli, $seasons, 'status')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `status` ENUM('draft','active','completed','archived') NOT NULL DEFAULT 'draft' AFTER `is_active`");
    }
    if (!$columnExists($mysqli, $seasons, 'ranking_method')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `ranking_method` ENUM('match_points','elo') NOT NULL DEFAULT 'match_points' AFTER `status`");
    }
    if (!$columnExists($mysqli, $seasons, 'points_win')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `points_win` DECIMAL(8,2) NOT NULL DEFAULT 2.00 AFTER `ranking_method`");
    }
    if (!$columnExists($mysqli, $seasons, 'points_draw')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `points_draw` DECIMAL(8,2) NOT NULL DEFAULT 1.00 AFTER `points_win`");
    }
    if (!$columnExists($mysqli, $seasons, 'points_loss')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `points_loss` DECIMAL(8,2) NOT NULL DEFAULT 0.00 AFTER `points_draw`");
    }
    if (!$columnExists($mysqli, $seasons, 'champion_player_id')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `champion_player_id` BIGINT UNSIGNED NULL AFTER `points_loss`");
    }
    if (!$columnExists($mysqli, $seasons, 'completed_at')) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD COLUMN `completed_at` DATETIME NULL AFTER `champion_player_id`");
    }

    $championFk = $prefix . 'fk_seasons_champion_player';
    if (!$constraintExists($mysqli, $seasons, $championFk)) {
        $mysqli->query("ALTER TABLE `{$seasons}` ADD CONSTRAINT `{$championFk}` FOREIGN KEY (`champion_player_id`) REFERENCES `{$players}` (`id`) ON DELETE SET NULL");
    }

    $mysqli->query("UPDATE `{$seasons}` SET status=IF(is_active=1,'active','draft') WHERE status='draft' AND is_active=1");
};