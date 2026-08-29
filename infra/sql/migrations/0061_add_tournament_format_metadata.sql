ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    ADD COLUMN `planned_tournament_format` VARCHAR(32) NOT NULL DEFAULT 'groups_playoff' AFTER `planned_playoff_best_of_legs`,
    ADD COLUMN `planned_starting_score` SMALLINT UNSIGNED NOT NULL DEFAULT 501 AFTER `planned_tournament_format`;
