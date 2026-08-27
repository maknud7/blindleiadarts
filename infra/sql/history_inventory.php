<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') throw new RuntimeException("Missing {$key}");
    return $value;
};

$db = mysqli_init();
if ($db === false) throw new RuntimeException('Could not initialize mysqli.');
$db->real_connect(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$p = $required('DB_TABLE_PREFIX');

$exists = static function (mysqli $db, string $table): bool {
    $stmt = $db->prepare('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?');
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $ok = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) === 1;
    $stmt->close();
    return $ok;
};

$printRows = static function (string $label, mysqli_result $result): void {
    echo "\n=== {$label} ===\n";
    foreach ($result->fetch_all(MYSQLI_ASSOC) as $row) {
        echo json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }
};

$printRows('seasons', $db->query(sprintf(
    'SELECT id,name,starts_on,ends_on,is_active,status,ranking_method FROM `%1$sseasons` ORDER BY starts_on DESC,id DESC LIMIT 15',
    $p
)));

$printRows('tournaments', $db->query(sprintf(
    'SELECT t.id,t.season_id,t.name,t.slug,t.provider_system,t.status,t.start_at,t.end_at,
            COUNT(DISTINCT m.id) matches,
            COUNT(DISTINCT l.id) legs,
            COUNT(DISTINCT v.id) visits
     FROM `%1$stournaments` t
     LEFT JOIN `%1$smatches` m ON m.tournament_id=t.id
     LEFT JOIN `%1$slegs` l ON l.match_id=m.id
     LEFT JOIN `%1$svisits` v ON v.match_id=m.id
     GROUP BY t.id,t.season_id,t.name,t.slug,t.provider_system,t.status,t.start_at,t.end_at
     ORDER BY t.start_at DESC,t.id DESC LIMIT 40',
    $p
)));

if ($exists($db, $p . 'external_references')) {
    $provider = 'darts' . 'atlas';
    $stmt = $db->prepare(sprintf(
        'SELECT external_system,external_entity_type,internal_entity_type,COUNT(*) refs,
                MIN(external_id) sample_external_id,MAX(last_synced_at) last_synced_at
         FROM `%1$sexternal_references`
         WHERE external_system=? OR external_system LIKE "%%atlas%%"
         GROUP BY external_system,external_entity_type,internal_entity_type
         ORDER BY refs DESC',
        $p
    ));
    $stmt->bind_param('s', $provider);
    $stmt->execute();
    $printRows('legacy external references', $stmt->get_result());
    $stmt->close();
}

if ($exists($db, $p . 'connector_sync_jobs')) {
    $provider = 'darts' . 'atlas';
    $stmt = $db->prepare(sprintf(
        'SELECT id,external_system,job_type,scope_entity_type,scope_entity_id,status,started_at,finished_at,error_message
         FROM `%1$sconnector_sync_jobs`
         WHERE external_system=? OR external_system LIKE "%%atlas%%"
         ORDER BY id DESC LIMIT 25',
        $p
    ));
    $stmt->bind_param('s', $provider);
    $stmt->execute();
    $printRows('legacy connector jobs', $stmt->get_result());
    $stmt->close();
}
