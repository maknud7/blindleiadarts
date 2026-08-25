ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    ADD COLUMN `planned_group_count` INT UNSIGNED DEFAULT NULL AFTER `group_count`,
    ADD COLUMN `planned_group_draw_mode` ENUM('elo_snake','elo_pots','random') DEFAULT NULL AFTER `planned_group_count`,
    ADD COLUMN `planned_group_best_of_legs` TINYINT UNSIGNED DEFAULT NULL AFTER `planned_group_draw_mode`,
    ADD COLUMN `planned_qualifiers_per_group` TINYINT UNSIGNED DEFAULT NULL AFTER `planned_group_best_of_legs`,
    ADD COLUMN `planned_playoff_best_of_legs` TINYINT UNSIGNED DEFAULT NULL AFTER `planned_qualifiers_per_group`;
