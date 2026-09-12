ALTER TABLE `{{TABLE_PREFIX}}tournament_players`
    MODIFY COLUMN `checkin_source` ENUM('player_code','admin_override','admin_guest','legacy') DEFAULT NULL;
