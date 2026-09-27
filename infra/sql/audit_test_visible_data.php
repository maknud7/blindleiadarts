<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db = new mysqli(
    (string) getenv('DB_HOST'),
    (string) getenv('DB_USERNAME'),
    (string) getenv('DB_PASSWORD'),
    (string) getenv('DB_NAME'),
    (int) (getenv('DB_PORT') ?: 3306)
);
$db->set_charset('utf8mb4');

$checks = [
    'clubs' => "SELECT id,name,slug FROM bd_test_clubs ORDER BY id DESC LIMIT 50",
    'tournaments' => "SELECT id,club_id,name,slug,status,start_at,created_at FROM bd_test_tournaments ORDER BY id DESC LIMIT 80",
    'seasons' => "SELECT id,club_id,name,is_active,created_at FROM bd_test_seasons ORDER BY id DESC LIMIT 50",
    'kiosks' => "SELECT id,club_id,code,name,board_number,is_active FROM bd_test_kiosks ORDER BY id DESC LIMIT 50",
    'players' => "SELECT id,club_id,display_name,is_active,created_at FROM bd_test_players ORDER BY id DESC LIMIT 80",
];

$needle = '/(smoke|test|e2e|verify|probe|fixture|diag|automation|synthetic)/i';

foreach ($checks as $label => $sql) {
    echo "## {$label}" . PHP_EOL;
    $res = $db->query($sql);
    $found = 0;
    while ($row = $res->fetch_assoc()) {
        $text = implode(' ', array_map(static fn($v): string => is_scalar($v) ? (string)$v : '', $row));
        if (!preg_match($needle, $text)) continue;
        $found++;
        echo json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    }
    if ($found === 0) echo "(none suspicious)" . PHP_EOL;
}
