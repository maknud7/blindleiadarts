CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_club_settings` (
    `club_id` BIGINT UNSIGNED NOT NULL,
    `enabled` TINYINT(1) NOT NULL DEFAULT 0,
    `access_token` TEXT DEFAULT NULL,
    `force_connect` TINYINT(1) NOT NULL DEFAULT 1,
    `forward_messages_to_scolia` TINYINT(1) NOT NULL DEFAULT 0,
    `disconnect_fallback_enabled` TINYINT(1) NOT NULL DEFAULT 1,
    `queue_max_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 8,
    `queue_retry_base_seconds` INT UNSIGNED NOT NULL DEFAULT 2,
    `event_retention_days` SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_club_settings_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_club_settings_user`
        FOREIGN KEY (`updated_by_user_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_board_settings` (
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `serial_number` VARCHAR(120) DEFAULT NULL,
    `mode` ENUM('off','shadow','live') NOT NULL DEFAULT 'off',
    `auto_fallback_to_manual` TINYINT(1) NOT NULL DEFAULT 1,
    `force_connect_override` TINYINT(1) DEFAULT NULL,
    `forward_messages_override` TINYINT(1) DEFAULT NULL,
    `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`kiosk_id`),
    UNIQUE KEY `uniq_scolia_board_serial` (`serial_number`),
    KEY `idx_scolia_board_mode` (`mode`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_board_settings_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_board_settings_user`
        FOREIGN KEY (`updated_by_user_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_board_runtime` (
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `connection_state` ENUM('disabled','disconnected','connecting','connected','error') NOT NULL DEFAULT 'disconnected',
    `board_status` VARCHAR(80) DEFAULT NULL,
    `board_phase` VARCHAR(80) DEFAULT NULL,
    `error_type` VARCHAR(150) DEFAULT NULL,
    `fallback_active` TINYINT(1) NOT NULL DEFAULT 0,
    `needs_reconciliation` TINYINT(1) NOT NULL DEFAULT 0,
    `last_disconnect_reason` VARCHAR(255) DEFAULT NULL,
    `last_bridge_heartbeat_at` DATETIME(3) DEFAULT NULL,
    `connected_at` DATETIME(3) DEFAULT NULL,
    `last_event_at` DATETIME(3) DEFAULT NULL,
    `last_disconnect_at` DATETIME(3) DEFAULT NULL,
    `last_reconciled_at` DATETIME(3) DEFAULT NULL,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`kiosk_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_board_runtime_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `match_id` BIGINT UNSIGNED DEFAULT NULL,
    `provider_event_id` VARCHAR(120) DEFAULT NULL,
    `dedupe_key` CHAR(64) NOT NULL,
    `event_type` VARCHAR(100) NOT NULL,
    `provider_detected_at` DATETIME(3) DEFAULT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `payload_json` JSON NOT NULL,
    `processing_status` ENUM('queued','processing','processed','ignored','failed','dead_letter') NOT NULL DEFAULT 'queued',
    `attempt_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) DEFAULT NULL,
    `last_error` TEXT DEFAULT NULL,
    `canonical_visit_id` BIGINT UNSIGNED DEFAULT NULL,
    `processing_meta_json` JSON DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_scolia_event_dedupe` (`dedupe_key`),
    KEY `idx_scolia_events_queue` (`processing_status`, `next_attempt_at`, `id`),
    KEY `idx_scolia_events_board` (`kiosk_id`, `received_at`),
    KEY `idx_scolia_events_match` (`match_id`, `id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_events_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_events_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_events_match`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE SET NULL,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_events_visit`
        FOREIGN KEY (`canonical_visit_id`) REFERENCES `{{TABLE_PREFIX}}visits` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_visit_buffers` (
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `darts_json` JSON NOT NULL,
    `event_ids_json` JSON NOT NULL,
    `provider_event_ids_json` JSON DEFAULT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`kiosk_id`),
    KEY `idx_scolia_buffer_match` (`match_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_buffer_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_buffer_match`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_buffer_player`
        FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_shadow_visits` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `match_id` BIGINT UNSIGNED NOT NULL,
    `player_id` BIGINT UNSIGNED NOT NULL,
    `darts_json` JSON NOT NULL,
    `score` INT NOT NULL,
    `darts_used` TINYINT UNSIGNED NOT NULL,
    `is_bust` TINYINT(1) NOT NULL DEFAULT 0,
    `is_checkout` TINYINT(1) NOT NULL DEFAULT 0,
    `remaining_before` INT NOT NULL,
    `remaining_after` INT NOT NULL,
    `source_event_ids_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    KEY `idx_scolia_shadow_match` (`match_id`, `id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_shadow_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_shadow_match`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_shadow_player`
        FOREIGN KEY (`player_id`) REFERENCES `{{TABLE_PREFIX}}players` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_commands` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED NOT NULL,
    `command_type` VARCHAR(100) NOT NULL,
    `message_id` VARCHAR(120) NOT NULL,
    `payload_json` JSON DEFAULT NULL,
    `status` ENUM('queued','delivered','acked','refused','failed','expired') NOT NULL DEFAULT 'queued',
    `attempt_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivered_at` DATETIME(3) DEFAULT NULL,
    `completed_at` DATETIME(3) DEFAULT NULL,
    `last_error` TEXT DEFAULT NULL,
    `created_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_scolia_command_message_id` (`message_id`),
    KEY `idx_scolia_commands_queue` (`kiosk_id`, `status`, `next_attempt_at`, `id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_commands_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_commands_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_commands_user`
        FOREIGN KEY (`created_by_user_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}scolia_incidents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `club_id` BIGINT UNSIGNED NOT NULL,
    `kiosk_id` BIGINT UNSIGNED DEFAULT NULL,
    `match_id` BIGINT UNSIGNED DEFAULT NULL,
    `severity` ENUM('info','warning','error','critical') NOT NULL DEFAULT 'warning',
    `category` VARCHAR(100) NOT NULL,
    `summary` VARCHAR(255) NOT NULL,
    `details` TEXT DEFAULT NULL,
    `context_json` JSON DEFAULT NULL,
    `status` ENUM('open','resolved') NOT NULL DEFAULT 'open',
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `occurrence_count` INT UNSIGNED NOT NULL DEFAULT 1,
    `resolved_at` DATETIME(3) DEFAULT NULL,
    `resolved_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_scolia_incidents_open` (`club_id`, `status`, `severity`, `last_seen_at`),
    KEY `idx_scolia_incidents_kiosk` (`kiosk_id`, `status`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_incidents_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_incidents_kiosk`
        FOREIGN KEY (`kiosk_id`) REFERENCES `{{TABLE_PREFIX}}kiosks` (`id`) ON DELETE SET NULL,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_incidents_match`
        FOREIGN KEY (`match_id`) REFERENCES `{{TABLE_PREFIX}}matches` (`id`) ON DELETE SET NULL,
    CONSTRAINT `{{TABLE_PREFIX}}fk_scolia_incidents_resolved_user`
        FOREIGN KEY (`resolved_by_user_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{TABLE_PREFIX}}club_checkin_settings` (
    `club_id` BIGINT UNSIGNED NOT NULL,
    `venue_latitude` DECIMAL(10,7) DEFAULT NULL,
    `venue_longitude` DECIMAL(10,7) DEFAULT NULL,
    `onsite_radius_meters` INT UNSIGNED NOT NULL DEFAULT 150,
    `opens_minutes_before_start` INT UNSIGNED NOT NULL DEFAULT 60,
    `closes_minutes_after_start` INT UNSIGNED NOT NULL DEFAULT 10,
    `require_geolocation` TINYINT(1) NOT NULL DEFAULT 1,
    `max_location_accuracy_meters` INT UNSIGNED NOT NULL DEFAULT 250,
    `updated_by_user_id` BIGINT UNSIGNED DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`club_id`),
    CONSTRAINT `{{TABLE_PREFIX}}fk_checkin_settings_club`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`) ON DELETE CASCADE,
    CONSTRAINT `{{TABLE_PREFIX}}fk_checkin_settings_user`
        FOREIGN KEY (`updated_by_user_id`) REFERENCES `{{TABLE_PREFIX}}user_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    ADD COLUMN `checkin_opens_at` DATETIME DEFAULT NULL AFTER `registration_closes_at`,
    ADD COLUMN `checkin_closes_at` DATETIME DEFAULT NULL AFTER `checkin_opens_at`,
    ADD COLUMN `checkin_require_onsite` TINYINT(1) DEFAULT NULL AFTER `checkin_closes_at`,
    ADD COLUMN `checkin_radius_meters` INT UNSIGNED DEFAULT NULL AFTER `checkin_require_onsite`;

ALTER TABLE `{{TABLE_PREFIX}}tournament_players`
    ADD COLUMN `checked_in_at` DATETIME(3) DEFAULT NULL AFTER `status`,
    ADD COLUMN `checkin_source` ENUM('player_geolocation','admin_override','legacy') DEFAULT NULL AFTER `checked_in_at`,
    ADD COLUMN `checkin_latitude` DECIMAL(10,7) DEFAULT NULL AFTER `checkin_source`,
    ADD COLUMN `checkin_longitude` DECIMAL(10,7) DEFAULT NULL AFTER `checkin_latitude`,
    ADD COLUMN `checkin_accuracy_meters` DECIMAL(10,2) DEFAULT NULL AFTER `checkin_longitude`,
    ADD COLUMN `checkin_distance_meters` DECIMAL(10,2) DEFAULT NULL AFTER `checkin_accuracy_meters`;
