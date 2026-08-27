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
$provider = 'darts' . 'atlas';

$print = static function (string $label, mysqli_result $result): void {
    echo "\n=== {$label} ===\n";
    foreach ($result->fetch_all(MYSQLI_ASSOC) as $row) {
        echo json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }
};

$stmt = $db->prepare(sprintf(
    'SELECT r.external_id,r.internal_id,t.name,t.status,t.start_at,t.end_at,t.provider_metadata
     FROM `%1$sexternal_references` r
     INNER JOIN `%1$stournaments` t ON t.id=r.internal_id
     WHERE r.external_system=? AND r.external_entity_type="tournament" AND r.internal_entity_type="tournament"
     ORDER BY t.id',
    $p
));
$stmt->bind_param('s', $provider);
$stmt->execute();
$print('tournament refs', $stmt->get_result());
$stmt->close();

$stmt = $db->prepare(sprintf(
    'SELECT r.external_id,r.internal_id,p.display_name,p.nickname,p.is_active
     FROM `%1$sexternal_references` r
     INNER JOIN `%1$splayers` p ON p.id=r.internal_id
     WHERE r.external_system=? AND r.external_entity_type="player" AND r.internal_entity_type="player"
     ORDER BY p.display_name,r.external_id',
    $p
));
$stmt->bind_param('s', $provider);
$stmt->execute();
$print('player refs', $stmt->get_result());
$stmt->close();

$stmt = $db->prepare(sprintf(
    'SELECT r.external_id,r.internal_id,m.tournament_id,t.name AS tournament_name,m.round_label,m.bracket_label,m.status,
            m.best_of_legs,m.legs_to_win,m.player_a_id,pa.display_name AS player_a,m.player_b_id,pb.display_name AS player_b,
            m.winner_player_id,pw.display_name AS winner,m.starts_at,m.finished_at
     FROM `%1$sexternal_references` r
     INNER JOIN `%1$smatches` m ON m.id=r.internal_id
     INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
     INNER JOIN `%1$splayers` pa ON pa.id=m.player_a_id
     INNER JOIN `%1$splayers` pb ON pb.id=m.player_b_id
     LEFT JOIN `%1$splayers` pw ON pw.id=m.winner_player_id
     WHERE r.external_system=? AND r.external_entity_type="match" AND r.internal_entity_type="match"
     ORDER BY m.tournament_id,m.id',
    $p
));
$stmt->bind_param('s', $provider);
$stmt->execute();
$print('match refs', $stmt->get_result());
$stmt->close();

foreach (['match_statistics','live_match_states','tournament_groups','tournament_group_players'] as $short) {
    $table = $p . $short;
    $check = $db->prepare('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?');
    $check->bind_param('s', $table);
    $check->execute();
    $exists = (int) ($check->get_result()->fetch_assoc()['c'] ?? 0) === 1;
    $check->close();
    if (!$exists) continue;
    $cols = $db->prepare('SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position');
    $cols->bind_param('s', $table);
    $cols->execute();
    $names = array_map(static fn (array $r): string => (string) $r['column_name'], $cols->get_result()->fetch_all(MYSQLI_ASSOC));
    $cols->close();
    echo "\n=== {$short} columns ===\n" . implode(',', $names) . "\n";
    $result = $db->query("SELECT * FROM `{$table}` ORDER BY id DESC LIMIT 120");
    $print($short, $result);
}
