<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException('Missing env: ' . $key);
    }
    return trim($value);
};

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

echo "MEMBER_SCHEMA_PROBE_BEGIN\n";

$columns = $db->query(
    "SELECT COLUMN_NAME, DATA_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='medlemmer'
      ORDER BY ORDINAL_POSITION"
);
while ($row = $columns->fetch_assoc()) {
    echo 'medlemmer.' . $row['COLUMN_NAME'] . ':' . $row['DATA_TYPE'] . "\n";
}

$tables = $db->query(
    "SELECT DISTINCT TABLE_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND (
          LOWER(TABLE_NAME) REGEXP 'kontingent|betaling|payment|member|medlem'
          OR LOWER(COLUMN_NAME) REGEXP 'kontingent|betalt|betaling|payment|paid|member_id|medlem_id|maaned|måned'
        )
      ORDER BY TABLE_NAME"
);
while ($table = $tables->fetch_assoc()) {
    $name = (string) $table['TABLE_NAME'];
    echo 'TABLE=' . $name . "\n";
    $stmt = $db->prepare(
        'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION'
    );
    $stmt->bind_param('s', $name);
    $stmt->execute();
    $result = $stmt->get_result();
    while ($row = $result->fetch_assoc()) {
        echo '  ' . $row['COLUMN_NAME'] . ':' . $row['DATA_TYPE'] . "\n";
    }
    $stmt->close();
}

echo "MEMBER_SCHEMA_PROBE_END\n";
$db->close();
