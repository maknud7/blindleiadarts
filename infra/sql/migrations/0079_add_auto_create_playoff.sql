ALTER TABLE `{{TABLE_PREFIX}}tournaments`
    ADD COLUMN `planned_auto_create_playoff` TINYINT(1) NOT NULL DEFAULT 1
    AFTER `planned_playoff_best_of_legs`;
