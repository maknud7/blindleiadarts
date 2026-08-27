<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $seasons = $prefix . 'seasons';
    $events = $prefix . 'season_ranking_events';
    $tournaments = $prefix . 'tournaments';
    $players = $prefix . 'players';

    $stmt = $mysqli->prepare(
        'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME="ranking_method" LIMIT 1'
    );
    $stmt->bind_param('s', $seasons);
    $stmt->execute();
    $type = strtolower((string) ($stmt->get_result()->fetch_assoc()['COLUMN_TYPE'] ?? ''));
    $stmt->close();
    if ($type !== '' && !str_contains($type, "'linear'")) {
        $mysqli->query(
            "ALTER TABLE `{$seasons}` MODIFY COLUMN `ranking_method` ENUM('match_points','linear','elo') NOT NULL DEFAULT 'match_points'"
        );
    }

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$events}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `season_id` BIGINT UNSIGNED NOT NULL,
            `tournament_id` BIGINT UNSIGNED NOT NULL,
            `player_id` BIGINT UNSIGNED NOT NULL,
            `entrants` SMALLINT UNSIGNED NOT NULL,
            `stage_label` VARCHAR(80) DEFAULT NULL,
            `stage_number` SMALLINT UNSIGNED DEFAULT NULL,
            `points` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            `ruleset` VARCHAR(50) NOT NULL DEFAULT 'linear_v1',
            `source` VARCHAR(50) NOT NULL DEFAULT 'local',
            `source_reference` VARCHAR(180) DEFAULT NULL,
            `status` ENUM('applied','reverted') NOT NULL DEFAULT 'applied',
            `metadata_json` JSON DEFAULT NULL,
            `applied_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
            `reverted_at` DATETIME(6) DEFAULT NULL,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_season_ranking_tournament_player` (`tournament_id`,`player_id`,`ruleset`),
            KEY `idx_season_ranking_season_status` (`season_id`,`status`),
            KEY `idx_season_ranking_player` (`player_id`),
            CONSTRAINT `{$prefix}fk_season_ranking_season`
                FOREIGN KEY (`season_id`) REFERENCES `{$seasons}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_season_ranking_tournament`
                FOREIGN KEY (`tournament_id`) REFERENCES `{$tournaments}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `{$prefix}fk_season_ranking_player`
                FOREIGN KEY (`player_id`) REFERENCES `{$players}` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
};
