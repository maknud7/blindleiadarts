ALTER TABLE `{{TABLE_PREFIX}}kiosks`
    ADD UNIQUE KEY `uniq_kiosks_club_board_number` (`club_id`, `board_number`);
