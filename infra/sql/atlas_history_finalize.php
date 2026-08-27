<?php

declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

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
    throw new RuntimeException('Usage: php atlas_history_finalize.php --external=<DartsAtlas tournament id>');
}

$prefix = $required('DB_TABLE_PREFIX');
if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
    throw new RuntimeException('Invalid DB_TABLE_PREFIX');
}
if ($prefix !== 'bd_test_' && $required('ALLOW_PROD_ATLAS_FINALIZE') !== 'yes') {
    throw new RuntimeException("Refusing historical finalization outside bd_test_ without ALLOW_PROD_ATLAS_FINALIZE=yes: {$prefix}");
}

$db = new mysqli(
    $required('DB_HOST'),
    $required('DB_USERNAME'),
    $required('DB_PASSWORD'),
    $required('DB_NAME'),
    (int) $required('DB_PORT')
);
$db->set_charset('utf8mb4');

$refs = $prefix . 'external_references';
$tournaments = $prefix . 'tournaments';
$players = $prefix . 'tournament_players';
$matches = $prefix . 'matches';
$legs = $prefix . 'legs';
$playoffs = $prefix . 'tournament_playoffs';
$nodes = $prefix . 'tournament_playoff_nodes';

$stmt = $db->prepare(
    "SELECT t.id,t.name,t.status,t.start_at,t.end_at
       FROM `{$refs}` er
       INNER JOIN `{$tournaments}` t ON t.id=er.internal_id
      WHERE er.external_system='dartsatlas'
        AND er.external_entity_type='tournament'
        AND er.internal_entity_type='tournament'
        AND er.external_id=?
      LIMIT 1"
);
$stmt->bind_param('s', $externalId);
$stmt->execute();
$tournament = $stmt->get_result()->fetch_assoc() ?: null;
$stmt->close();
if ($tournament === null) {
    throw new RuntimeException("DartsAtlas tournament {$externalId} is not mapped locally.");
}
$tournamentId = (int) $tournament['id'];

$db->begin_transaction();
try {
    $stmt = $db->prepare("SELECT id,status,start_at,end_at FROM `{$tournaments}` WHERE id=? FOR UPDATE");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $locked = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($locked === null) throw new RuntimeException('Tournament disappeared during finalization.');

    $stmt = $db->prepare(
        "SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='completed' AND winner_player_id IS NOT NULL AND finished_at IS NOT NULL THEN 1 ELSE 0 END) AS complete,
                MAX(finished_at) AS latest_finished_at
           FROM `{$matches}` WHERE tournament_id=?"
    );
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $matchState = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $matchTotal = (int) ($matchState['total'] ?? 0);
    $matchComplete = (int) ($matchState['complete'] ?? 0);
    if ($matchTotal < 1 || $matchTotal !== $matchComplete) {
        throw new RuntimeException("Refusing to finalize: {$matchComplete}/{$matchTotal} matches are canonically complete.");
    }

    $stmt = $db->prepare(
        "SELECT COUNT(*) AS cnt
           FROM `{$players}` tp
          WHERE tp.tournament_id=?
            AND NOT EXISTS (
                SELECT 1 FROM `{$matches}` m
                 WHERE m.tournament_id=tp.tournament_id
                   AND (m.player_a_id=tp.player_id OR m.player_b_id=tp.player_id)
            )"
    );
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $withoutMatches = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
    $stmt->close();
    if ($withoutMatches !== 0) {
        throw new RuntimeException("Refusing to finalize: {$withoutMatches} tournament participants have no match history.");
    }

    $stmt = $db->prepare("SELECT id,status,champion_player_id FROM `{$playoffs}` WHERE tournament_id=? LIMIT 1 FOR UPDATE");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $playoff = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();
    if ($playoff === null || (string) $playoff['status'] !== 'completed' || empty($playoff['champion_player_id'])) {
        throw new RuntimeException('Refusing to finalize: completed playoff with champion is required.');
    }
    $playoffId = (int) $playoff['id'];
    $championId = (int) $playoff['champion_player_id'];

    $stmt = $db->prepare(
        "SELECT COUNT(*) AS total,
                SUM(CASE WHEN n.status='completed' AND n.winner_player_id IS NOT NULL AND n.match_id IS NOT NULL AND m.status='completed' THEN 1 ELSE 0 END) AS complete
           FROM `{$nodes}` n
           LEFT JOIN `{$matches}` m ON m.id=n.match_id
          WHERE n.playoff_id=?"
    );
    $stmt->bind_param('i', $playoffId);
    $stmt->execute();
    $nodeState = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();
    $nodeTotal = (int) ($nodeState['total'] ?? 0);
    $nodeComplete = (int) ($nodeState['complete'] ?? 0);
    if ($nodeTotal < 1 || $nodeTotal !== $nodeComplete) {
        throw new RuntimeException("Refusing to finalize: {$nodeComplete}/{$nodeTotal} playoff nodes are complete.");
    }

    // Historical source does not contain exact wall-clock finish timestamps per leg.
    // Reuse the already imported match finish marker instead of inventing a new time.
    $stmt = $db->prepare(
        "UPDATE `{$legs}` l
         INNER JOIN `{$matches}` m ON m.id=l.match_id
            SET l.finished_at=COALESCE(l.finished_at,m.finished_at)
          WHERE m.tournament_id=? AND l.status='completed' AND l.finished_at IS NULL"
    );
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $legsFinalized = $stmt->affected_rows;
    $stmt->close();

    // Mirror canonical playoff lifecycle: every loser is eliminated; champion remains checked in.
    $stmt = $db->prepare(
        "UPDATE `{$players}`
            SET status='eliminated'
          WHERE tournament_id=? AND player_id<>?"
    );
    $stmt->bind_param('ii', $tournamentId, $championId);
    $stmt->execute();
    $eliminated = $stmt->affected_rows;
    $stmt->close();

    $stmt = $db->prepare(
        "UPDATE `{$players}` SET status='checked_in' WHERE tournament_id=? AND player_id=?"
    );
    $stmt->bind_param('ii', $tournamentId, $championId);
    $stmt->execute();
    $stmt->close();

    $latestFinishedAt = $matchState['latest_finished_at'] ?: $locked['start_at'];
    if ($latestFinishedAt === null) {
        throw new RuntimeException('Refusing to finalize: no historical completion timestamp can be derived.');
    }
    $stmt = $db->prepare(
        "UPDATE `{$tournaments}`
            SET status='completed', end_at=COALESCE(end_at,?)
          WHERE id=?"
    );
    $stmt->bind_param('si', $latestFinishedAt, $tournamentId);
    $stmt->execute();
    $stmt->close();

    $db->commit();
} catch (Throwable $error) {
    $db->rollback();
    throw $error;
}

echo 'ATLAS_HISTORY_FINALIZE ' . json_encode([
    'ok' => true,
    'external_id' => $externalId,
    'tournament_id' => $tournamentId,
    'tournament_name' => $tournament['name'],
    'matches' => $matchTotal,
    'champion_player_id' => $championId,
    'end_at' => $latestFinishedAt,
    'legs_timestamped' => $legsFinalized,
    'players_eliminated' => $eliminated,
    'prefix' => $prefix,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
