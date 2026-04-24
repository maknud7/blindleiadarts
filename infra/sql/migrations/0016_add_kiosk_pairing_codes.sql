ALTER TABLE `{{TABLE_PREFIX}}clubs`
    ADD COLUMN `kiosk_pairing_code` VARCHAR(16) DEFAULT NULL AFTER `logo_url`,
    ADD UNIQUE KEY `uniq_clubs_kiosk_pairing_code` (`kiosk_pairing_code`);

ALTER TABLE `{{TABLE_PREFIX}}kiosk_pairing_requests`
    ADD COLUMN `club_id` BIGINT UNSIGNED DEFAULT NULL AFTER `id`,
    ADD KEY `idx_kiosk_pairing_requests_club_id` (`club_id`),
    ADD CONSTRAINT `{{TABLE_PREFIX}}fk_kiosk_pairing_requests_club_id`
        FOREIGN KEY (`club_id`) REFERENCES `{{TABLE_PREFIX}}clubs` (`id`);
