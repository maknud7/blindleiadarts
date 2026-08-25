UPDATE `{{TABLE_PREFIX}}club_checkin_settings`
SET `default_method` = 'admin_or_code'
WHERE `default_method` = 'gps';

UPDATE `{{TABLE_PREFIX}}tournaments`
SET `checkin_method` = 'admin_or_code'
WHERE `checkin_method` = 'gps';

UPDATE `{{TABLE_PREFIX}}tournament_players`
SET `checkin_source` = 'legacy'
WHERE `checkin_source` = 'player_geolocation';

ALTER TABLE `{{TABLE_PREFIX}}club_checkin_settings`
    MODIFY COLUMN `default_method` ENUM('admin_or_code','admin_only','code') NOT NULL DEFAULT 'admin_or_code',
    DROP COLUMN `venue_latitude`,
    DROP COLUMN `venue_longitude`,
    DROP COLUMN `onsite_radius_meters`,
    DROP COLUMN `require_geolocation`,
    DROP COLUMN `gps_fallback_enabled`,
    DROP COLUMN `max_location_accuracy_meters`;

ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    MODIFY COLUMN `checkin_method` ENUM('admin_or_code','admin_only','code') DEFAULT NULL,
    DROP COLUMN `checkin_require_onsite`,
    DROP COLUMN `checkin_gps_fallback_enabled`,
    DROP COLUMN `checkin_radius_meters`;

ALTER TABLE `{{TABLE_PREFIX}}tournament_players`
    MODIFY COLUMN `checkin_source` ENUM('player_code','admin_override','legacy') DEFAULT NULL,
    DROP COLUMN `checkin_latitude`,
    DROP COLUMN `checkin_longitude`,
    DROP COLUMN `checkin_accuracy_meters`,
    DROP COLUMN `checkin_distance_meters`;
