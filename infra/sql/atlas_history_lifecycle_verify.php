<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};
$options = getopt('', ['external:']);
$externalId = trim((string) ($options['external'] ?? ''));
if ($externalId === '') throw new RuntimeException('Usage: php atlas_history_lifecycle_verify.php --external=<DartsAtlas tournament id>');
$prefix = $required('DB_TABLE_PREFIX');
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) throw new RuntimeException('Invalid DB_TABLE_PREFIX');

$db = new mysqli($required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'), $required('DB_NAME'), (int) $required('DB_PORT'));
$db->set_charset('utf8mb4');

$refs = $prefix . 'external_references';
$tournaments = $prefix . 'tournaments';
$tournamentPlayers = $prefix . 'tournament_players';
$matches = $prefix . 'matches';
$legs = $prefix . 'legs';
$playoffs = $prefix . 'tournament_playoffs';
$nodes = $prefix . 'tournament_playoff_nodes';

$stmt = $db->prepare(
    "SELECT t.id,t.name,t.status,t.start_at,t.end_at
       FROM `{$refs}` er
       INNER JOIN `{$tournaments}` t ON t.id=er.internal_id
      WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament'
        AND er.internal_entity_type='tournament' AND er.external_id=? LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$tournament = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($tournament === null) throw new RuntimeException("Tournament reference not found for {$externalId}");
$tournamentId = (int) $tournament['id'];

$failures = [];
$check = static function (bool $ok, string $code, array $context = []) use (&$failures): void {
    echo ($ok ? 'PASS ' : 'FAIL ') . $code;
    if ($context !== []) echo ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    echo "\n";
    if (!$ok) $failures[] = ['code' => $code, 'context' => $context];
};

$check((string) $tournament['status'] === 'completed', 'tournament_completed', ['status' => $tournament['status']]);
$check(!empty($tournament['end_at']), 'tournament_has_end_at', ['start_at' => $tournament['start_at'], 'end_at' => $tournament['end_at']]);
if (!empty($tournament['start_at']) && !empty($tournament['end_at'])) {
    $check(strtotime((string) $tournament['end_at']) >= strtotime((string) $tournament['start_at']), 'tournament_time_order');
}

$stmt = $db->prepare(
    "SELECT COUNT(*) total,
            SUM(CASE WHEN status='completed' AND winner_player_id IS NOT NULL AND finished_at IS NOT NULL THEN 1 ELSE 0 END) complete
       FROM `{$matches}` WHERE tournament_id=?"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$matchState = $stmt->get_result()->fetch_assoc() ?: [];
$stmt->close();
$check((int) ($matchState['total'] ?? 0) > 0 && (int) ($matchState['total'] ?? 0) === (int) ($matchState['complete'] ?? -1), 'matches_closed', $matchState);

$stmt = $db->prepare(
    "SELECT COUNT(*) total,
            SUM(CASE WHEN l.status='completed' AND l.winner_player_id IS NOT NULL AND l.finished_at IS NOT NULL THEN 1 ELSE 0 END) complete
       FROM `{$legs}` l
       INNER JOIN `{$matches}` m ON m.id=l.match_id
      WHERE m.tournament_id=?"
);
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$legState = $stmt->get_result()->fetch_assoc() ?: [];
$stmt->close();
$check((int) ($legState['total'] ?? 0) > 0 && (int) ($legState['total'] ?? 0) === (int) ($legState['complete'] ?? -1), 'legs_closed', $legState);

$stmt = $db->prepare("SELECT id,status,champion_player_id FROM `{$playoffs}` WHERE tournament_id=? LIMIT 1");
$stmt->bind_param('i', $tournamentId);
$stmt->execute();
$playoff = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
$check($playoff !== null, 'playoff_present');
$championId = $playoff !== null && $playoff['champion_player_id'] !== null ? (int) $playoff['champion_player_id'] : 0;
if ($playoff !== null) {
    $check((string) $playoff['status'] === 'completed' && $championId > 0, 'playoff_completed', ['status' => $playoff['status'], 'champion_player_id' => $championId]);
    $playoffId = (int) $playoff['id'];
    $stmt = $db->prepare(
        "SELECT COUNT(*) total,
                SUM(CASE WHEN n.status='completed' AND n.winner_player_id IS NOT NULL AND n.match_id IS NOT NULL AND m.status='completed' THEN 1 ELSE 0 END) complete
           FROM `{$nodes}` n LEFT JOIN `{$matches}` m ON m.id=n.match_id WHERE n.playoff_id=?"
    );
    $stmt->bind_param('i', $playoffId);
    $stmt->execute();
    $nodeState = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $check((int) ($nodeState['total'] ?? 0) > 0 && (int) ($nodeState['total'] ?? 0) === (int) ($nodeState['complete'] ?? -1), 'playoff_nodes_closed', $nodeState);
}

if ($championId > 0) {
    $stmt = $db->prepare(
        "SELECT
            SUM(CASE WHEN player_id=? AND status='checked_in' THEN 1 ELSE 0 END) champion_ok,
            SUM(CASE WHEN player_id<>? AND status='eliminated' THEN 1 ELSE 0 END) losers_ok,
            SUM(CASE WHEN player_id<>? THEN 1 ELSE 0 END) losers_total,
            GROUP_CONCAT(CONCAT(player_id,':',status) ORDER BY player_id SEPARATOR ',') statuses
         FROM `{$tournamentPlayers}` WHERE tournament_id=?"
    );
    $stmt->bind_param('iiii', $championId, $championId, $championId, $tournamentId);
    $stmt->execute();
    $participantState = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $check((int) ($participantState['champion_ok'] ?? 0) === 1, 'champion_registration_lifecycle', ['statuses' => $participantState['statuses'] ?? null]);
    $check((int) ($participantState['losers_ok'] ?? -1) === (int) ($participantState['losers_total'] ?? -2), 'loser_registration_lifecycle', ['losers_ok' => $participantState['losers_ok'] ?? null, 'losers_total' => $participantState['losers_total'] ?? null, 'statuses' => $participantState['statuses'] ?? null]);
}

$summary = [
    'ok' => $failures === [],
    'external_id' => $externalId,
    'tournament_id' => $tournamentId,
    'tournament_name' => $tournament['name'],
    'failures' => $failures,
];
echo 'ATLAS_HISTORY_LIFECYCLE_SUMMARY ' . json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
exit($failures === [] ? 0 : 1);
