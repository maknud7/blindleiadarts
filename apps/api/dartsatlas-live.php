<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasScreenRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
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
            throw new RuntimeException('No DartsAtlas club id or screen club slug configured.');
        }
        $clubs = $prefix . 'clubs';
        $statement = $db->prepare("SELECT id FROM `{$clubs}` WHERE slug = ? LIMIT 1");
        $statement->bind_param('s', $slug);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();
        if (!$row) {
            throw new RuntimeException('Configured screen club was not found.');
        }
        $clubId = (int) $row['id'];
    }

    $requestedTournament = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $tournamentId = is_int($requestedTournament) && $requestedTournament > 0
        ? $requestedTournament
        : null;

    $tournaments = $prefix . 'tournaments';
    $clubs = $prefix . 'clubs';
    if ($tournamentId !== null) {
        $statement = $db->prepare(
            "SELECT t.id, t.name, t.status, t.season_id, t.provider_system,
                    c.name AS club_name, c.logo_url AS club_logo_url
             FROM `{$tournaments}` t
             INNER JOIN `{$clubs}` c ON c.id = t.club_id
             WHERE t.id = ? AND t.club_id = ? AND t.provider_system = 'dartsatlas'
             LIMIT 1"
        );
        $statement->bind_param('ii', $tournamentId, $clubId);
    } else {
        $statement = $db->prepare(
            "SELECT t.id, t.name, t.status, t.season_id, t.provider_system,
                    c.name AS club_name, c.logo_url AS club_logo_url
             FROM `{$tournaments}` t
             INNER JOIN `{$clubs}` c ON c.id = t.club_id
             WHERE t.club_id = ? AND t.provider_system = 'dartsatlas'
             ORDER BY FIELD(t.status, 'in_progress', 'ready', 'completed', 'archived'),
                      COALESCE(t.start_at, t.updated_at) DESC, t.id DESC
             LIMIT 1"
        );
        $statement->bind_param('i', $clubId);
    }

    $statement->execute();
    $tournament = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($tournament === null) {
        $respond([
            'ok' => true,
            'data' => [
                'club_id' => $clubId,
                'tournament' => null,
                'feed' => ['provider' => 'dartsatlas', 'status' => 'idle'],
                'live_boards' => [],
                'next_matches' => [],
                'standings' => [],
                'stats' => [],
            ],
        ]);
    }

    $tournamentId = (int) $tournament['id'];
    $screenRepository = new DartsAtlasScreenRepository($database);
    $tournamentRepository = new TournamentRepository($database);

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'club' => [
                'id' => $clubId,
                'name' => $tournament['club_name'],
                'logo_url' => $tournament['club_logo_url'],
            ],
            'tournament' => [
                'id' => $tournamentId,
                'name' => $tournament['name'],
                'status' => $tournament['status'],
                'season_id' => $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null,
                'provider_system' => 'dartsatlas',
            ],
            'feed' => $screenRepository->feedStatus($tournamentId),
            'live_boards' => $screenRepository->listScreenBoardsByTournament($clubId, $tournamentId),
            'next_matches' => $tournamentRepository->listUpcomingMatchesByTournamentId($tournamentId, 8),
            'standings' => $screenRepository->listStandingsByTournamentId($tournamentId, 8),
            'stats' => [
                'highlights' => $screenRepository->highlights($tournamentId),
                'best_match_averages' => $screenRepository->listBestMatchAveragesByTournamentId($tournamentId, 5),
                'elo' => $tournamentRepository->listScreenRankings(
                    $tournamentId,
                    $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null,
                    'elo',
                    5
                ),
                'order_of_merit' => $tournamentRepository->listScreenRankings(
                    $tournamentId,
                    $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null,
                    'order_of_merit',
                    5
                ),
            ],
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_live_unavailable',
            'message' => 'DartsAtlas live data is not available.',
            'detail' => isset($config) && $config->appEnv() === 'prod' ? null : $error->getMessage(),
        ],
    ], 503);
}
