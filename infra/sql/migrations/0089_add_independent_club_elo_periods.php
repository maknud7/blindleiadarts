<?php

declare(strict_types=1);

// Club ELO periods are independent of competition seasons. No historical
// rating, match, event or season rows are modified by this migration.
return static function (mysqli $mysqli, string $prefix): void {
    $periods = $prefix . 'club_elo_periods';
    $clubs = $prefix . 'clubs';
    $seasons = $prefix . 'seasons';
    $tournaments = $prefix . 'tournaments';

    $mysqli->query(
        "CREATE TABLE IF NOT EXISTS `{$periods}` (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `club_id` BIGINT UNSIGNED NOT NULL,
            `name` VARCHAR(150) NOT NULL,
            `starts_on` DATE NOT NULL,
            `ends_on` DATE NULL,
            `open_slot` TINYINT UNSIGNED NULL DEFAULT 1,
            `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_club_elo_period_start` (`club_id`, `starts_on`),
            UNIQUE KEY `uniq_club_elo_period_open` (`club_id`, `open_slot`),
            KEY `idx_club_elo_period_dates` (`club_id`, `ends_on`, `starts_on`),
            CONSTRAINT `{$prefix}fk_club_elo_period_club`
                FOREIGN KEY (`club_id`) REFERENCES `{$clubs}` (`id`) ON DELETE CASCADE,
            CONSTRAINT `chk_{$prefix}elo_period_order`
                CHECK (`ends_on` IS NULL OR `ends_on` >= `starts_on`),
            CONSTRAINT `chk_{$prefix}elo_period_open_slot`
                CHECK ((`ends_on` IS NULL AND `open_slot` = 1)
                    OR (`ends_on` IS NOT NULL AND `open_slot` IS NULL))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    // One open-ended initial ELO per existing club. Start at the active
    // competition's opening date if it exists, to preserve the ongoing
    // season's 1000-point baseline without rewriting earlier ELO events.
    // Future seasons will NOT reset this club-level period.
    $mysqli->query(
        "INSERT INTO `{$periods}` (club_id,name,starts_on,ends_on,open_slot)
         SELECT c.id,CONCAT(c.name,' ELO'),
                LEAST(COALESCE(
                    (SELECT s.starts_on FROM `{$seasons}` s
                      WHERE s.club_id=c.id AND s.is_active=1 AND s.starts_on IS NOT NULL
                      ORDER BY s.starts_on DESC,s.id DESC LIMIT 1),
                    (SELECT DATE(MIN(t.start_at)) FROM `{$tournaments}` t
                      WHERE t.club_id=c.id AND t.elo_enabled=1 AND t.start_at IS NOT NULL),
                    CURRENT_DATE
                ), CURRENT_DATE),
                NULL,1
           FROM `{$clubs}` c
          WHERE NOT EXISTS (SELECT 1 FROM `{$periods}` ep WHERE ep.club_id=c.id)"
    );
};
