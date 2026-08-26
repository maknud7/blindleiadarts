UPDATE `{{TABLE_PREFIX}}scolia_board_settings`
SET `mode` = 'live'
WHERE `mode` = 'shadow';

ALTER TABLE `{{TABLE_PREFIX}}scolia_board_settings`
MODIFY COLUMN `mode` ENUM('off','live') NOT NULL DEFAULT 'off';
