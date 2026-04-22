UPDATE `{{TABLE_PREFIX}}clubs`
SET `logo_url` = '/static/club-logos/blindleia-dartklubb-logo.png'
WHERE `slug` = 'blindleia-dartklubb'
  AND (`logo_url` IS NULL OR `logo_url` = '');
