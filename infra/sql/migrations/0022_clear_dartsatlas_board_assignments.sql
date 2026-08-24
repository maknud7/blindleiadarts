UPDATE `{{TABLE_PREFIX}}matches` m
INNER JOIN `{{TABLE_PREFIX}}tournaments` t ON t.id = m.tournament_id
SET m.kiosk_id = NULL
WHERE t.provider_system = 'dartsatlas'
  AND m.kiosk_id IS NOT NULL;
