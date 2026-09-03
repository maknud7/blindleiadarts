UPDATE `{{TABLE_PREFIX}}tournaments`
SET `planned_auto_create_playoff` = 0
WHERE `planned_auto_create_playoff` = 1
  AND (`planned_qualifiers_per_group` IS NULL OR `planned_playoff_best_of_legs` IS NULL);
