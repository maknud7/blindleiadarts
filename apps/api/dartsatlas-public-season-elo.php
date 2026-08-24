<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\PublicLiveInsights;
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
        if ($slug === '') {
            throw new RuntimeException('Could not resolve DartsAtlas club.');
        }
        $statement = $db->prepare("SELECT id, name, logo_url FROM `{$prefix}clubs` WHERE slug = ? LIMIT 1");
        $statement->bind_param('s', $slug);
        $statement->execute();
        $club = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        if (!$club) {
            throw new RuntimeException('Could not resolve DartsAtlas club.');
        }
        $clubId = (int) $club['id'];
    } else {
        $statement = $db->prepare("SELECT id, name, logo_url FROM `{$prefix}clubs` WHERE id = ? LIMIT 1");
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $club = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
    }

    $seasonId = $dartsAtlas->localSeasonId();
    if ($seasonId === null) {
        $statement = $db->prepare(
            "SELECT id FROM `{$prefix}seasons` WHERE club_id = ? ORDER BY is_active DESC, id DESC LIMIT 1"
        );
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $season = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        $seasonId = $season ? (int) $season['id'] : null;
    }

    if ($seasonId === null) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'club' => $club ?: null,
                'season_id' => null,
                'live_elo' => ['baseline' => 1000, 'table' => [], 'changes' => []],
            ],
        ]);
    }

    $statement = $db->prepare(
        "SELECT id FROM `{$prefix}tournaments`
         WHERE club_id = ? AND season_id = ? AND provider_system = 'dartsatlas'
         ORDER BY COALESCE(start_at, created_at) DESC, id DESC LIMIT 1"
    );
    $statement->bind_param('ii', $clubId, $seasonId);
    $statement->execute();
    $tournament = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    $elo = ['baseline' => 1000, 'table' => [], 'changes' => []];
    if ($tournament) {
        $elo = (new PublicLiveInsights($database))->liveElo((int) $tournament['id'], $seasonId, 50);
        $elo['changes'] = [];
    }

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'club' => $club ?: null,
            'season_id' => $seasonId,
            'live_elo' => $elo,
        ],
    ]);
} catch (Throwable $error) {
    $payload = [
        'ok' => false,
        'error' => 'Public season ELO is not available.',
    ];
    if (isset($config) && $config instanceof Config && $config->appEnv() !== 'prod') {
        $payload['detail'] = $error->getMessage();
    }
    $respond($payload, 503);
}
