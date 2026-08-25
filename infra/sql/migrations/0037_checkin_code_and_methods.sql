ALTER TABLE `{{TABLE_PREFIX}}club_checkin_settings`
    ADD COLUMN `default_method` ENUM('admin_or_code','admin_only','code','gps') NOT NULL DEFAULT 'admin_or_code' AFTER `club_id`,
    ADD COLUMN `gps_fallback_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `require_geolocation`;

ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    ADD COLUMN `checkin_method` ENUM('admin_or_code','admin_only','code','gps') DEFAULT NULL AFTER `checkin_closes_at`,
    ADD COLUMN `checkin_code` VARCHAR(12) DEFAULT NULL AFTER `checkin_method`,
    ADD COLUMN `checkin_gps_fallback_enabled` TINYINT(1) DEFAULT NULL AFTER `checkin_require_onsite`,
    ADD UNIQUE KEY `uniq_tournament_checkin_code` (`club_id`, `checkin_code`);

ALTER TABLE `{{TABLE_PREFIX}}tournament_players`
    MODIFY COLUMN `checkin_source` ENUM('player_code','player_geolocation','admin_override','legacy') DEFAULT NULL;
