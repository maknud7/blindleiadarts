ALTER TABLE `{{TABLE_PREFIX}}user_accounts`
    MODIFY COLUMN `role` ENUM('player', 'admin', 'club_admin', 'super_admin') NOT NULL DEFAULT 'player';

UPDATE `{{TABLE_PREFIX}}user_accounts`
SET `role` = 'super_admin'
WHERE `role` = 'admin';
