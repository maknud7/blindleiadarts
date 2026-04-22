ALTER TABLE `{{TABLE_PREFIX}}kiosks`
    ADD COLUMN `scoring_mode` ENUM('manual', 'scolia') NOT NULL DEFAULT 'manual'
    AFTER `sponsor_logo_url`;
