<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') { exit(2); }
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$get = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') { throw new RuntimeException('Missing env: ' . $key); }
    return $value;
};

$db = new mysqli($get('DB_HOST'), $get('DB_USERNAME'), $get('DB_PASSWORD'), $get('DB_NAME'), (int) $get('DB_PORT'));
$db->set_charset('utf8mb4');
$prefix = getenv('DB_TABLE_PREFIX') ?: 'bd_test_';
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) { throw new RuntimeException('Invalid prefix'); }
$players = '`' . $prefix . 'players`';

$sql = "
SELECT COUNT(*) AS c
FROM {$players} p
JOIN (
    SELECT LOWER(TRIM(CONVERT(display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci AS n, COUNT(*) AS cnt
    FROM {$players}
    GROUP BY LOWER(TRIM(CONVERT(display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci
) pg
  ON pg.n = LOWER(TRIM(CONVERT(p.display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci
 AND pg.cnt = 1
JOIN (
    SELECT LOWER(TRIM(CONVERT(navn USING utf8mb4))) COLLATE utf8mb4_unicode_ci AS n, MIN(id) AS member_id, COUNT(*) AS cnt
    FROM `medlemmer`
    GROUP BY LOWER(TRIM(CONVERT(navn USING utf8mb4))) COLLATE utf8mb4_unicode_ci
) mg
  ON mg.n = LOWER(TRIM(CONVERT(p.display_name USING utf8mb4))) COLLATE utf8mb4_unicode_ci
 AND mg.cnt = 1
WHERE p.member_id IS NULL
";

$count = (int) ($db->query($sql)->fetch_assoc()['c'] ?? 0);
echo 'MATCHING safe_one_to_one_player_member_names=' . $count . PHP_EOL;
