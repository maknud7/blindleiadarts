<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function env_req(string $key): string
{
    $value = getenv($key);
    if ($value === false || $value === '') throw new RuntimeException("Missing {$key}");
    return $value;
}

$db = new mysqli(env_req('DB_HOST'), env_req('DB_USERNAME'), env_req('DB_PASSWORD'), env_req('DB_NAME'), (int) env_req('DB_PORT'));
$db->set_charset('utf8mb4');
$p = env_req('DB_TABLE_PREFIX');

$tables = ['scolia_club_settings','scolia_board_settings','scolia_board_runtime','scolia_events','scolia_visit_buffers','scolia_shadow_visits','scolia_commands','scolia_incidents','club_checkin_settings'];
foreach ($tables as $table) {
    $full = $p . $table;
    $stmt = $db->prepare('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?');
    $stmt->bind_param('s', $full);
    $stmt->execute();
    if ((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) !== 1) throw new RuntimeException("Missing table {$full}");
    $stmt->close();
}

$required = [
    'scolia_board_runtime' => ['fallback_active','needs_reconciliation','turn_locked_until_takeout','last_bridge_heartbeat_at'],
    'scolia_events' => ['dedupe_key','processing_status','attempt_count','next_attempt_at','canonical_visit_id'],
    'club_checkin_settings' => ['default_method','opens_minutes_before_start','closes_minutes_after_start'],
    'tournaments' => ['checkin_opens_at','checkin_closes_at','checkin_method','checkin_code','planned_group_count','planned_group_draw_mode','planned_group_best_of_legs','planned_qualifiers_per_group','planned_playoff_best_of_legs'],
    'tournament_players' => ['checked_in_at','checkin_source'],
];
foreach ($required as $table => $names) {
    $full = $p . $table;
    foreach ($names as $column) {
        $stmt = $db->prepare('SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?');
        $stmt->bind_param('ss', $full, $column);
        $stmt->execute();
        if ((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) !== 1) throw new RuntimeException("Missing column {$full}.{$column}");
        $stmt->close();
    }
}

$forbidden = [
    'club_checkin_settings' => ['venue_latitude','venue_longitude','onsite_radius_meters','require_geolocation','gps_fallback_enabled','max_location_accuracy_meters'],
    'tournaments' => ['checkin_require_onsite','checkin_gps_fallback_enabled','checkin_radius_meters'],
    'tournament_players' => ['checkin_latitude','checkin_longitude','checkin_accuracy_meters','checkin_distance_meters'],
];
foreach ($forbidden as $table => $names) {
    $full = $p . $table;
    foreach ($names as $column) {
        $stmt = $db->prepare('SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?');
        $stmt->bind_param('ss', $full, $column);
        $stmt->execute();
        if ((int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0) !== 0) throw new RuntimeException("Legacy GPS column still exists: {$full}.{$column}");
        $stmt->close();
    }
}

$enumChecks = [
    [$p . 'club_checkin_settings', 'default_method'],
    [$p . 'tournaments', 'checkin_method'],
    [$p . 'tournament_players', 'checkin_source'],
];
foreach ($enumChecks as [$table, $column]) {
    $stmt = $db->prepare('SELECT column_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=? LIMIT 1');
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $type = strtolower((string) ($stmt->get_result()->fetch_assoc()['column_type'] ?? ''));
    $stmt->close();
    if (str_contains($type, 'gps') || str_contains($type, 'geolocation')) {
        throw new RuntimeException("Legacy GPS enum value still exists: {$table}.{$column}");
    }
}

echo "Scolia/code-admin check-in schema doctor OK\n";
