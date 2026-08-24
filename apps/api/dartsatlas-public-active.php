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

    // A started tournament can disappear from DartsAtlas' upcoming schedule.
    // Prefer actual recent match activity over the next scheduled event. The
    // 12-hour window deliberately keeps tonight's completed event visible for
    // the rest of the evening, while excluding old rounds such as #1.
    $statement = $db->prepare(
        "SELECT
            t.id,
            t.name,
            t.status,
            er.external_id,
            SUM(CASE WHEN m.status='in_progress' THEN 1 ELSE 0 END) AS live_match_count,
            SUM(CASE WHEN m.status='completed' AND m.updated_at >= (NOW() - INTERVAL 12 HOUR) THEN 1 ELSE 0 END) AS recent_completed_count,
            MAX(CASE WHEN m.status IN ('in_progress','completed') THEN m.updated_at ELSE NULL END) AS last_activity_at
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
             last_activity_at DESC,
             t.id DESC
         LIMIT 1"
    );
    $statement->bind_param('i', $clubId);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($row === null) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'active' => false,
                'tournament_id' => null,
            ],
        ]);
    }

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'active' => true,
            'tournament_id' => (int) $row['id'],
            'external_id' => (string) $row['external_id'],
            'name' => (string) $row['name'],
            'status' => (string) $row['status'],
            'live_match_count' => (int) ($row['live_match_count'] ?? 0),
            'recent_completed_count' => (int) ($row['recent_completed_count'] ?? 0),
            'last_activity_at' => $row['last_activity_at'],
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
