CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}clubs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `slug` VARCHAR(150) DEFAULT NULL,
    `logo_url` VARCHAR(255) DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_club_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}seasons` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `starts_on` DATE DEFAULT NULL,
    `ends_on` DATE DEFAULT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 0,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_seasons_club_id` (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_seasons_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}tournaments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `season_id` BIGINT UNSIGNED DEFAULT NULL,
    `name` VARCHAR(180) NOT NULL,
    `slug` VARCHAR(180) DEFAULT NULL,
    `provider_system` VARCHAR(50) NOT NULL DEFAULT 'local',
    `provider_metadata` JSON DEFAULT NULL,
    `status` ENUM('draft', 'ready', 'in_progress', 'completed', 'archived') NOT NULL DEFAULT 'draft',
    `max_visits_per_leg` TINYINT UNSIGNED NOT NULL DEFAULT 50,
    `start_at` DATETIME DEFAULT NULL,
    `end_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_tournament_slug` (`slug`),
    KEY `idx_tournaments_club_id` (`club_id`),
    KEY `idx_tournaments_season_id` (`season_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournaments_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournaments_season_id` FOREIGN KEY (`season_id`) REFERENCES `{{TABLE_PREFIX}}seasons` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}players` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED DEFAULT NULL,
    `display_name` VARCHAR(150) NOT NULL,
    `first_name` VARCHAR(120) DEFAULT NULL,
    `last_name` VARCHAR(120) DEFAULT NULL,
    `nickname` VARCHAR(120) DEFAULT NULL,
    `avatar_url` VARCHAR(255) DEFAULT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_players_club_id` (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_players_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}kiosks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(80) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `board_number` INT UNSIGNED NOT NULL,
    `sponsor_label` VARCHAR(150) DEFAULT NULL,
    `sponsor_logo_url` VARCHAR(255) DEFAULT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `last_seen_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_kiosk_code` (`code`),
    KEY `idx_kiosks_club_id` (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_kiosks_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}tournament_players` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tournament_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `seed` INT UNSIGNED DEFAULT NULL,
    `status` ENUM('registered', 'checked_in', 'withdrawn', 'eliminated') NOT NULL DEFAULT 'registered',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_tournament_player` (`tournament_id`, `player_id`),
    KEY `idx_tournament_players_player_id` (`player_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournament_players_tournament_id` FOREIGN KEY (`tournament_id`) REFERENCES `{{TABLE_PREFIX}}tournaments` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_tournament_players_player_id` FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}matches` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tournament_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED DEFAULT NULL,
    `round_label` VARCHAR(120) DEFAULT NULL,
    `bracket_label` VARCHAR(120) DEFAULT NULL,
    `status` ENUM('pending', 'assigned', 'in_progress', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
    `best_of_legs` TINYINT UNSIGNED NOT NULL DEFAULT 3,
    `legs_to_win` TINYINT UNSIGNED NOT NULL DEFAULT 2,
    `player_a_id` BIGINT UNSIGNED NOT NULL,
    `player_b_id` BIGINT UNSIGNED NOT NULL,
    `winner_player_id` BIGINT UNSIGNED DEFAULT NULL,
    `starts_at` DATETIME DEFAULT NULL,
    `finished_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_matches_tournament_id` (`tournament_id`),
    KEY `idx_matches_kiosk_id` (`kiosk_id`),
    KEY `idx_matches_player_a_id` (`player_a_id`),
    KEY `idx_matches_player_b_id` (`player_b_id`),
    KEY `idx_matches_winner_player_id` (`winner_player_id`),
    KEY `idx_matches_status` (`status`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_matches_tournament_id` FOREIGN KEY (`tournament_id`) REFERENCES `{{TABLE_PREFIX}}tournaments` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_matches_kiosk_id` FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_matches_player_a_id` FOREIGN KEY (`player_a_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_matches_player_b_id` FOREIGN KEY (`player_b_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_matches_winner_player_id` FOREIGN KEY (`winner_player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}legs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `leg_number` INT UNSIGNED NOT NULL,
    `starting_player_id` BIGINT UNSIGNED DEFAULT NULL,
    `winner_player_id` BIGINT UNSIGNED DEFAULT NULL,
    `status` ENUM('pending', 'in_progress', 'completed') NOT NULL DEFAULT 'pending',
    `start_score` INT UNSIGNED NOT NULL DEFAULT 501,
    `finished_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_legs_match_leg_number` (`match_id`, `leg_number`),
    KEY `idx_legs_starting_player_id` (`starting_player_id`),
    KEY `idx_legs_winner_player_id` (`winner_player_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_legs_match_id` FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_legs_starting_player_id` FOREIGN KEY (`starting_player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_legs_winner_player_id` FOREIGN KEY (`winner_player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}visits` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `leg_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `visit_number` INT UNSIGNED NOT NULL,
    `score` INT NOT NULL,
    `darts_used` TINYINT UNSIGNED NOT NULL DEFAULT 3,
    `input_mode` ENUM('sum', 'per_dart') NOT NULL DEFAULT 'sum',
    `darts_json` JSON DEFAULT NULL,
    `is_bust` TINYINT(1) NOT NULL DEFAULT 0,
    `remaining_after` INT DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_visits_match_id` (`match_id`),
    KEY `idx_visits_leg_id` (`leg_id`),
    KEY `idx_visits_player_id` (`player_id`),
    UNIQUE KEY `uniq_visits_leg_player_visit_number` (`leg_id`, `player_id`, `visit_number`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_visits_match_id` FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_visits_leg_id` FOREIGN KEY (`leg_id`) REFERENCES `{{TABLE_PREFIX}}legs` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_visits_player_id` FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED DEFAULT NULL,
    `setting_key` VARCHAR(120) NOT NULL,
    `setting_value` TEXT DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_settings_club_key` (`club_id`, `setting_key`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_settings_club_id` FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}kiosk_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `session_token` VARCHAR(120) NOT NULL,
    `app_version` VARCHAR(50) DEFAULT NULL,
    `opened_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `closed_at` DATETIME DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_kiosk_sessions_token` (`session_token`),
    KEY `idx_kiosk_sessions_kiosk_id` (`kiosk_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_kiosk_sessions_kiosk_id` FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}ranking_snapshots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `season_id` BIGINT UNSIGNED DEFAULT NULL,
    `tournament_id` BIGINT UNSIGNED DEFAULT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `ranking_type` ENUM('elo', 'order_of_merit') NOT NULL,
    `scope_type` ENUM('tournament', 'season') NOT NULL,
    `points` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `position` INT UNSIGNED DEFAULT NULL,
    `context_json` JSON DEFAULT NULL,
    `calculated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_ranking_snapshots_season_id` (`season_id`),
    KEY `idx_ranking_snapshots_tournament_id` (`tournament_id`),
    KEY `idx_ranking_snapshots_player_id` (`player_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_ranking_snapshots_season_id` FOREIGN KEY (`season_id`) REFERENCES `{{TABLE_PREFIX}}seasons` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_ranking_snapshots_tournament_id` FOREIGN KEY (`tournament_id`) REFERENCES `{{TABLE_PREFIX}}tournaments` (`id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_ranking_snapshots_player_id` FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}external_references` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `external_system` VARCHAR(50) NOT NULL,
    `external_entity_type` VARCHAR(50) NOT NULL,
    `external_id` VARCHAR(150) NOT NULL,
    `internal_entity_type` VARCHAR(50) NOT NULL,
    `internal_id` BIGINT UNSIGNED NOT NULL,
    `sync_state` ENUM('pending', 'synced', 'conflict', 'failed') NOT NULL DEFAULT 'pending',
    `last_synced_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_external_reference` (`external_system`, `external_entity_type`, `external_id`),
    KEY `idx_external_references_internal` (`internal_entity_type`, `internal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}connector_sync_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `external_system` VARCHAR(50) NOT NULL,
    `job_type` VARCHAR(50) NOT NULL,
    `scope_entity_type` VARCHAR(50) DEFAULT NULL,
    `scope_entity_id` BIGINT UNSIGNED DEFAULT NULL,
    `status` ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
    `summary_json` JSON DEFAULT NULL,
    `error_message` TEXT DEFAULT NULL,
    `started_at` DATETIME DEFAULT NULL,
    `finished_at` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_connector_sync_jobs_status` (`status`),
    KEY `idx_connector_sync_jobs_scope` (`scope_entity_type`, `scope_entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}webhook_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `external_system` VARCHAR(50) NOT NULL,
    `event_type` VARCHAR(100) NOT NULL,
    `delivery_id` VARCHAR(150) DEFAULT NULL,
    `payload` LONGTEXT NOT NULL,
    `processing_status` ENUM('received', 'processed', 'failed', 'ignored') NOT NULL DEFAULT 'received',
    `error_message` TEXT DEFAULT NULL,
    `received_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `processed_at` DATETIME DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_webhook_events_delivery_id` (`delivery_id`),
    KEY `idx_webhook_events_processing_status` (`processing_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
