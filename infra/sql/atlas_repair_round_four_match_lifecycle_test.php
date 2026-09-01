<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$required = static function (string $key): string {
    $value = getenv($key);
    if ($value === false || trim($value) === '') throw new RuntimeException("Missing {$key}");
    return trim($value);
};
if ($required('DB_TABLE_PREFIX') !== 'bd_test_') throw new RuntimeException('Round-four lifecycle repair is TEST-only.');
if ($required('ALLOW_TEST_ROUND_FOUR_LIFECYCLE_REPAIR') !== 'yes') {
    throw new RuntimeException('Explicit lifecycle repair allow flag is required.');
}

$db = new mysqli(
    $required('DB_HOST'), $required('DB_USERNAME'), $required('DB_PASSWORD'),
    $required('DB_NAME'), (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');
$prefix = 'bd_test_';
$externalId = 'jort2WSBWFwN';
$stmt = $db->prepare(
    "SELECT t.id,t.start_at,COUNT(m.id) matches,
            SUM(CASE WHEN m.status='completed' AND m.winner_player_id IS NOT NULL THEN 1 ELSE 0 END) resolved,
            SUM(CASE WHEN m.finished_at IS NULL THEN 1 ELSE 0 END) missing_finished
       FROM `{$prefix}external_references` er
       INNER JOIN `{$prefix}tournaments` t ON t.id=er.internal_id
       INNER JOIN `{$prefix}matches` m ON m.tournament_id=t.id
      WHERE er.external_system='dartsatlas' AND er.external_entity_type='tournament'
        AND er.external_id=? AND er.internal_entity_type='tournament'
      GROUP BY t.id,t.start_at LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$state = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($state === null || (int) $state['matches'] !== 37 || (int) $state['resolved'] !== 37 || empty($state['start_at'])) {
    throw new RuntimeException('Round-four TEST skeleton is not the frozen 37-match resolved history.');
}
$tournamentId = (int) $state['id'];
$missing = (int) $state['missing_finished'];
if ($missing > 0) {
    $repair = $db->prepare(
        "UPDATE `{$prefix}matches`
            SET finished_at=?
          WHERE tournament_id=? AND status='completed' AND winner_player_id IS NOT NULL AND finished_at IS NULL"
    );
    $startAt = (string) $state['start_at'];
    $repair->bind_param('si', $startAt, $tournamentId);
    $repair->execute();
    if ($repair->affected_rows !== $missing) {
        throw new RuntimeException("Lifecycle repair changed {$repair->affected_rows}/{$missing} expected matches.");
    }
    $repair->close();
}
$remaining = (int) ($db->query(
    "SELECT COUNT(*) c FROM `{$prefix}matches` WHERE tournament_id={$tournamentId} AND finished_at IS NULL"
)->fetch_assoc()['c'] ?? 0);
if ($remaining !== 0) throw new RuntimeException("Round-four finished_at repair left {$remaining} matches incomplete.");
fwrite(STDOUT, "ROUND4_TEST_MATCH_LIFECYCLE_OK=yes repaired={$missing}\n");
