ALTER TABLE `{{TABLE_PREFIX}}scolia_events`
    ADD COLUMN `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 50 AFTER `event_type`,
    ADD COLUMN `processing_started_at` DATETIME(3) DEFAULT NULL AFTER `next_attempt_at`,
    ADD KEY `idx_scolia_events_priority_queue` (`processing_status`, `next_attempt_at`, `priority`, `kiosk_id`, `id`);

ALTER TABLE `{{TABLE_PREFIX}}scolia_commands`
    ADD COLUMN `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 50 AFTER `command_type`,
    ADD KEY `idx_scolia_commands_priority_queue` (`status`, `next_attempt_at`, `priority`, `kiosk_id`, `id`);
