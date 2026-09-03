<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function required_env_elo(string $key): string
{
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing required environment variable: {$key}");
    }
    return $value;
}

$db = new mysqli(
    required_env_elo('DB_HOST'),
    required_env_elo('DB_USERNAME'),
    required_env_elo('DB_PASSWORD'),
    required_env_elo('DB_NAME'),
    (int) required_env_elo('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = required_env_elo('DB_TABLE_PREFIX');

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$tables = [];
$result = $db->query('SHOW TABLES');
while ($row = $result->fetch_row()) {
    $tables[(string) $row[0]] = true;
}
foreach ([$prefix . 'elo_match_events', $prefix . 'elo_current_ratings'] as $table) {
    $assert(isset($tables[$table]), "Missing ELO table {$table}.");
}

$columns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}tournaments`");
while ($row = $result->fetch_assoc()) {
    $columns[(string) $row['Field']] = $row;
}
$assert(isset($columns['elo_enabled']), 'tournaments.elo_enabled is missing.');

$eventColumns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}elo_match_events`");
while ($row = $result->fetch_assoc()) {
    $eventColumns[(string) $row['Field']] = true;
}
foreach ([
    'match_id', 'season_id', 'player_a_id', 'player_b_id', 'winner_player_id',
    'rating_a_before', 'rating_b_before', 'rating_a_after', 'rating_b_after',
    'delta_a', 'delta_b', 'matches_before_a', 'matches_before_b', 'k_a', 'k_b',
    'status', 'applied_at', 'reverted_at',
] as $column) {
    $assert(isset($eventColumns[$column]), "elo_match_events.{$column} is missing.");
}

$currentColumns = [];
$result = $db->query("SHOW COLUMNS FROM `{$prefix}elo_current_ratings`");
while ($row = $result->fetch_assoc()) {
    $currentColumns[(string) $row['Field']] = true;
}
foreach (['season_id', 'player_id', 'rating', 'matches_played', 'last_event_id'] as $column) {
    $assert(isset($currentColumns[$column]), "elo_current_ratings.{$column} is missing.");
}

$uniqueMatchIndex = false;
$result = $db->query("SHOW INDEX FROM `{$prefix}elo_match_events`");
while ($row = $result->fetch_assoc()) {
    if ((string) $row['Column_name'] === 'match_id' && (int) $row['Non_unique'] === 0) {
        $uniqueMatchIndex = true;
        break;
    }
}
$assert($uniqueMatchIndex, 'elo_match_events.match_id must be unique.');

// A player is ELO-eligible when the row itself is member-linked, or when a legacy
// null-member alias resolves by normalized name to exactly one member in the club.
$eligibleA = "(
    COALESCE(pa.member_id,0)>0
    OR (
        SELECT COUNT(DISTINCT pa2.member_id)
        FROM `{$prefix}players` pa2
        WHERE pa2.club_id=t.club_id
          AND COALESCE(pa2.member_id,0)>0
          AND LOWER(TRIM(pa2.display_name))=LOWER(TRIM(pa.display_name))
    )=1
)";
$eligibleB = "(
    COALESCE(pb.member_id,0)>0
    OR (
        SELECT COUNT(DISTINCT pb2.member_id)
        FROM `{$prefix}players` pb2
        WHERE pb2.club_id=t.club_id
          AND COALESCE(pb2.member_id,0)>0
          AND LOWER(TRIM(pb2.display_name))=LOWER(TRIM(pb.display_name))
    )=1
)";
$memberMatch = "({$eligibleA} AND {$eligibleB})";

$baseJoins = "
    INNER JOIN `{$prefix}tournaments` t ON t.id=m.tournament_id
    INNER JOIN `{$prefix}players` pa ON pa.id=m.player_a_id
    INNER JOIN `{$prefix}players` pb ON pb.id=m.player_b_id";
$baseWhere = "m.status='completed' AND t.elo_enabled=1 AND t.season_id IS NOT NULL";

$eligibleSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    WHERE {$baseWhere} AND {$memberMatch}";
$eligible = (int) (($db->query($eligibleSql)->fetch_assoc()['c'] ?? 0));

$guestSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    WHERE {$baseWhere} AND NOT {$memberMatch}";
$guestMatches = (int) (($db->query($guestSql)->fetch_assoc()['c'] ?? 0));

$missingSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    LEFT JOIN `{$prefix}elo_match_events` e ON e.match_id=m.id
    WHERE {$baseWhere} AND {$memberMatch}
      AND (
        e.id IS NULL OR e.status<>'applied'
        OR NOT (e.winner_player_id <=> m.winner_player_id)
        OR e.season_id<>t.season_id
        OR e.player_a_id<>m.player_a_id
        OR e.player_b_id<>m.player_b_id
      )";
$missing = (int) (($db->query($missingSql)->fetch_assoc()['c'] ?? 0));
$assert($missing === 0, "ELO ledger is missing or inconsistent for {$missing} eligible completed match(es).");

$guestAppliedSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    INNER JOIN `{$prefix}elo_match_events` e ON e.match_id=m.id AND e.status='applied'
    WHERE {$baseWhere} AND NOT {$memberMatch}";
$guestApplied = (int) (($db->query($guestAppliedSql)->fetch_assoc()['c'] ?? 0));
$assert($guestApplied === 0, "ELO ledger still contains {$guestApplied} applied guest match(es).");

$incompleteSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}elo_match_events` e
    INNER JOIN `{$prefix}matches` m ON m.id=e.match_id
    {$baseJoins}
    WHERE {$baseWhere} AND {$memberMatch} AND e.status='applied'
      AND (
        e.rating_a_before IS NULL OR e.rating_b_before IS NULL
        OR e.rating_a_after IS NULL OR e.rating_b_after IS NULL
        OR e.delta_a IS NULL OR e.delta_b IS NULL
        OR e.matches_before_a IS NULL OR e.matches_before_b IS NULL
        OR e.k_a IS NULL OR e.k_b IS NULL
      )";
$incomplete = (int) (($db->query($incompleteSql)->fetch_assoc()['c'] ?? 0));
$assert($incomplete === 0, "ELO calculation fields are incomplete for {$incomplete} eligible match(es).");

$snapshotMissingSql = "
    SELECT COUNT(*) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    WHERE {$baseWhere} AND {$memberMatch}
      AND (
        SELECT COUNT(*)
        FROM `{$prefix}ranking_snapshots` rs
        WHERE rs.ranking_type='elo'
          AND rs.season_id=t.season_id
          AND JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.source'))='elo_ledger'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(rs.context_json, '$.match_id')) AS UNSIGNED)=m.id
      ) <> 2";
$snapshotMissing = (int) (($db->query($snapshotMissingSql)->fetch_assoc()['c'] ?? 0));
$assert($snapshotMissing === 0, "Match-level ELO snapshots are missing for {$snapshotMissing} eligible completed match(es).");

$seasonCountSql = "
    SELECT COUNT(DISTINCT t.season_id) AS c
    FROM `{$prefix}matches` m
    {$baseJoins}
    WHERE {$baseWhere} AND {$memberMatch}";
$seasonCount = (int) (($db->query($seasonCountSql)->fetch_assoc()['c'] ?? 0));

$currentCount = (int) (($db->query("SELECT COUNT(*) AS c FROM `{$prefix}elo_current_ratings`")->fetch_assoc()['c'] ?? 0));

echo "ELO ledger OK: {$eligible} eligible completed matches, {$guestMatches} guest-neutral match(es), {$seasonCount} season(s), {$currentCount} current player ratings.\n";
