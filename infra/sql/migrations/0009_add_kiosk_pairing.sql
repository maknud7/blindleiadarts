ALTER TABLE `{{TABLE_PREFIX}}kiosks`
    ADD COLUMN `pairing_token_hash` VARCHAR(255) DEFAULT NULL AFTER `scoring_mode`,
    ADD COLUMN `paired_device_name` VARCHAR(150) DEFAULT NULL AFTER `pairing_token_hash`,
    ADD COLUMN `paired_at` DATETIME DEFAULT NULL AFTER `paired_device_name`;
