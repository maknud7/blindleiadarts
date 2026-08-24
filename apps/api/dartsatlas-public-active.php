<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $dartsAtlas = $config->dartsAtlas();

    $clubId = $dartsAtlas->clubId();
    if ($clubId <= 0) {
        $slug = trim($config->screenDefaultClubSlug());
        if ($slug !== '') {
            $statement = $db->prepare("SELECT id FROM `{$prefix}clubs` WHERE slug=? LIMIT 1");
            $statement->bind_param('s', $slug);
            $statement->execute();
            $row = $statement->get_result()->fetch_assoc() ?: null;
            $statement->close();
            if ($row !== null) {
                $clubId = (int) $row['id'];
            }
        }
    }

    if ($clubId <= 0) {
        throw new RuntimeException('Could not resolve DartsAtlas club.');
    }

    $tournaments = $prefix . 'tournaments';
    $matches = $prefix . 'matches';
    $references = $prefix . 'external_references';

    // Actual match activity always wins. For completed matches use finished_at,
    // not updated_at: a later re-sync must never make an old round look current.
    $statement = $db->prepare(
        "SELECT
            t.id,
            t.name,
            t.status,
            er.external_id,
            SUM(CASE WHEN m.status='in_progress' THEN 1 ELSE 0 END) AS live_match_count,
            SUM(CASE WHEN m.status='completed' AND m.finished_at >= (NOW() - INTERVAL 12 HOUR) THEN 1 ELSE 0 END) AS recent_completed_count,
            MAX(CASE
                WHEN m.status='in_progress' THEN m.updated_at
                WHEN m.status='completed' THEN m.finished_at
                ELSE NULL
            END) AS last_activity_at
         FROM `{$tournaments}` t
         INNER JOIN `{$references}` er
           ON er.external_system='dartsatlas'
          AND er.external_entity_type='tournament'
          AND er.internal_entity_type='tournament'
          AND er.internal_id=t.id
         LEFT JOIN `{$matches}` m ON m.tournament_id=t.id
         WHERE t.club_id=?
           AND t.provider_system='dartsatlas'
         GROUP BY t.id, t.name, t.status, er.external_id
         HAVING t.status='in_progress'
             OR live_match_count > 0
             OR recent_completed_count > 0
         ORDER BY
             live_match_count DESC,
             CASE WHEN t.status='in_progress' THEN 0 ELSE 1 END,
             recent_completed_count DESC,
             last_activity_at DESC,
             t.id DESC
         LIMIT 1"
    );
    $statement->bind_param('i', $clubId);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($row !== null) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'active' => true,
                'selection' => 'match_activity',
                'tournament_id' => (int) $row['id'],
                'external_id' => (string) $row['external_id'],
                'name' => (string) $row['name'],
                'status' => (string) $row['status'],
                'live_match_count' => (int) ($row['live_match_count'] ?? 0),
                'recent_completed_count' => (int) ($row['recent_completed_count'] ?? 0),
                'last_activity_at' => $row['last_activity_at'],
            ],
        ]);
    }

    // Transition fallback for numbered weekly rounds. The browser only sends
    // before_tournament_id when the next scheduled event is exactly seven days
    // away. If #4 has replaced today's #3 in DartsAtlas schedule before the
    // first live snapshot arrives, resolve #3 by name in the same season.
    $before = filter_input(INPUT_GET, 'before_tournament_id', FILTER_VALIDATE_INT);
    $beforeTournamentId = is_int($before) && $before > 0 ? $before : null;
    if ($beforeTournamentId !== null) {
        $statement = $db->prepare(
            "SELECT id, season_id, name
             FROM `{$tournaments}`
             WHERE id=? AND club_id=? AND provider_system='dartsatlas'
             LIMIT 1"
        );
        $statement->bind_param('ii', $beforeTournamentId, $clubId);
        $statement->execute();
        $future = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($future !== null && preg_match('/^(.*#)\s*(\d+)\s*$/u', trim((string) $future['name']), $match)) {
            $number = (int) $match[2];
            if ($number > 1) {
                $previousName = trim($match[1]) . ($number - 1);
                $seasonId = $future['season_id'] !== null ? (int) $future['season_id'] : 0;
                $statement = $db->prepare(
                    "SELECT t.id, t.name, t.status, er.external_id
                     FROM `{$tournaments}` t
                     INNER JOIN `{$references}` er
                       ON er.external_system='dartsatlas'
                      AND er.external_entity_type='tournament'
                      AND er.internal_entity_type='tournament'
                      AND er.internal_id=t.id
                     WHERE t.club_id=?
                       AND t.provider_system='dartsatlas'
                       AND t.name=?
                       AND ((? > 0 AND t.season_id=?) OR (? = 0))
                     ORDER BY t.id DESC
                     LIMIT 1"
                );
                $statement->bind_param('isiii', $clubId, $previousName, $seasonId, $seasonId, $seasonId);
                $statement->execute();
                $previous = $statement->get_result()->fetch_assoc() ?: null;
                $statement->close();

                if ($previous !== null) {
                    $respond([
                        'ok' => true,
                        'generated_at' => gmdate('c'),
                        'data' => [
                            'active' => true,
                            'selection' => 'previous_numbered_round',
                            'tournament_id' => (int) $previous['id'],
                            'external_id' => (string) $previous['external_id'],
                            'name' => (string) $previous['name'],
                            'status' => (string) $previous['status'],
                            'live_match_count' => 0,
                            'recent_completed_count' => 0,
                            'last_activity_at' => null,
                        ],
                    ]);
                }
            }
        }
    }

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'active' => false,
            'tournament_id' => null,
        ],
    ]);
} catch (Throwable $error) {
    $payload = [
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_active_tournament_unavailable',
            'message' => 'Could not resolve active DartsAtlas tournament.',
        ],
    ];
    if (isset($config) && $config instanceof Config && $config->appEnv() !== 'prod') {
        $payload['error']['detail'] = $error->getMessage();
    }
    $respond($payload, 503);
}
