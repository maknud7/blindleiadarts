ALTER TABLE `{{TABLE_PREFIX}}players`
    ADD COLUMN `preferred_input_mode` ENUM('sum', 'per_dart') DEFAULT NULL AFTER `nickname`;
