<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException('Missing env: ' . $key);
    }
    return $value;
};

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$name = (string) ($db->query('SELECT DATABASE() AS db')->fetch_assoc()['db'] ?? '');

echo 'TARGET_IS_INGENTINGORG01=' . ($name === 'ingentingorg01' ? 'yes' : 'no') . PHP_EOL;
echo 'TARGET_IS_INGENTINGORG02=' . ($name === 'ingentingorg02' ? 'yes' : 'no') . PHP_EOL;
