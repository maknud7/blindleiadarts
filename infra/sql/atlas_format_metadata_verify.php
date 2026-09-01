<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
require_once __DIR__ . '/atlas_format_metadata.php';

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') {
        throw new RuntimeException("Missing {$key}");
    }
    return trim($value);
};

$options = getopt('', ['external:']);
$externalId = trim((string) ($options['external'] ?? ''));
if ($externalId === '') {
    throw new RuntimeException('Usage: php atlas_format_metadata_verify.php --external=<DartsAtlas tournament id>');
}

$prefix = $required('DB_TABLE_PREFIX');
atlas_format_metadata_validate_prefix($prefix);
$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$refs = $prefix . 'external_references';
$stmt = $db->prepare(
    "SELECT internal_id
       FROM `{$refs}`
      WHERE external_system='dartsatlas'
        AND external_entity_type='tournament'
        AND internal_entity_type='tournament'
        AND external_id=?
      LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($row === null) {
    throw new RuntimeException("DartsAtlas tournament {$externalId} is not mapped locally.");
}

$tournamentId = (int) $row['internal_id'];
$metadata = atlas_assert_format_metadata($db, $prefix, $tournamentId);
echo 'ATLAS_FORMAT_METADATA_VERIFY_OK=yes external_id=' . $externalId
    . ' tournament_id=' . $tournamentId
    . ' metadata=' . json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
    . "\n";
