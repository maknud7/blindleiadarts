-- Older in-progress tournaments could implicitly use every active club board without
-- rows in tournament_kiosks. Live board mutation is intentionally explicit, so
-- materialize that legacy runtime state once. Draft/ready tournaments stay implicit
-- until an administrator explicitly confirms their board selection.

INSERT IGNORE INTO `{{TABLE_PREFIX}}tournament_kiosks`
    (`tournament_id`, `kiosk_id`, `sort_order`)
SELECT
    t.id AS tournament_id,
    k.id AS kiosk_id,
    1 + (
        SELECT COUNT(*)
        FROM `{{TABLE_PREFIX}}kiosks` k2
        WHERE k2.club_id = t.club_id
          AND k2.is_active = 1
          AND (
              k2.board_number < k.board_number
              OR (k2.board_number = k.board_number AND k2.id < k.id)
          )
    ) AS sort_order
FROM `{{TABLE_PREFIX}}tournaments` t
INNER JOIN `{{TABLE_PREFIX}}kiosks` k
    ON k.club_id = t.club_id
   AND k.is_active = 1
WHERE t.status = 'in_progress'
  AND NOT EXISTS (
      SELECT 1
      FROM `{{TABLE_PREFIX}}tournament_kiosks` tk
      WHERE tk.tournament_id = t.id
  );
