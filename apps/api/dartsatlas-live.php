<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Repository\DartsAtlasScreenRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Service\DartsAtlasSyncService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;

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
        $dartsAtlas = $dartsAtlas->withClubId($clubId);
    }

    $requestedTournament = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $tournamentId = is_int($requestedTournament) && $requestedTournament > 0
        ? $requestedTournament
        : null;

    $tournaments = $prefix . 'tournaments';
    $clubs = $prefix . 'clubs';
    if ($tournamentId !== null) {
        $statement = $db->prepare(
            "SELECT t.id, t.name, t.status, t.season_id, t.provider_system, t.provider_metadata,
                    c.name AS club_name, c.logo_url AS club_logo_url
             FROM `{$tournaments}` t
             INNER JOIN `{$clubs}` c ON c.id = t.club_id
             WHERE t.id = ? AND t.club_id = ? AND t.provider_system = 'dartsatlas'
             LIMIT 1"
        );
        $statement->bind_param('ii', $tournamentId, $clubId);
    } else {
        $statement = $db->prepare(
            "SELECT t.id, t.name, t.status, t.season_id, t.provider_system, t.provider_metadata,
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
    $feed = $screenRepository->feedStatus($tournamentId);
    $feedAge = isset($feed['age_seconds']) && is_numeric($feed['age_seconds'])
        ? (int) $feed['age_seconds']
        : null;

    $canRefresh = in_array((string) $tournament['status'], ['ready', 'in_progress'], true);
    $refreshDue = $canRefresh
        && ($feedAge === null || $feedAge >= $dartsAtlas->pollIntervalSeconds());
    $refreshAttempted = false;
    $refreshSkipped = null;

    if ($refreshDue) {
        $references = $prefix . 'external_references';
        $statement = $db->prepare(
            "SELECT external_id
             FROM `{$references}`
             WHERE external_system = 'dartsatlas'
               AND external_entity_type = 'tournament'
               AND internal_entity_type = 'tournament'
               AND internal_id = ?
             LIMIT 1"
        );
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $reference = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        $externalTournamentId = trim((string) ($reference['external_id'] ?? ''));
        $metadata = [];
        if (is_string($tournament['provider_metadata'] ?? null) && $tournament['provider_metadata'] !== '') {
            $decoded = json_decode((string) $tournament['provider_metadata'], true);
            if (is_array($decoded)) {
                $metadata = $decoded;
            }
        }
        $seasonExternalId = trim($dartsAtlas->seasonId());
        if ($seasonExternalId === '') {
            $seasonExternalId = trim((string) ($metadata['season_external_id'] ?? ''));
        }

        if ($externalTournamentId === '') {
            $refreshSkipped = 'missing_external_tournament_id';
        } elseif ($seasonExternalId === '') {
            $refreshSkipped = 'missing_external_season_id';
        } else {
            $refreshAttempted = true;
            try {
                $repository = new DartsAtlasRepository($database, $dartsAtlas->membersTable());
                $service = new DartsAtlasSyncService(
                    new DartsAtlasHttpClient($dartsAtlas->userAgent()),
                    new DartsAtlasParser(),
                    $repository,
                    $dartsAtlas,
                );
                $summary = $service->syncSeason($seasonExternalId, $externalTournamentId);
                if (($summary['skipped'] ?? false) === true) {
                    $refreshSkipped = (string) ($summary['reason'] ?? 'sync_skipped');
                }
            } catch (Throwable $syncError) {
                // A transient upstream/parser problem must never blank the venue display.
                $refreshSkipped = 'refresh_failed';
            }

            $feed = $screenRepository->feedStatus($tournamentId);
        }
    }

    $feed['refresh_attempted'] = $refreshAttempted;
    if ($refreshSkipped !== null) {
        $feed['refresh_skipped'] = $refreshSkipped;
    }
    $feed['poll_interval_seconds'] = $dartsAtlas->pollIntervalSeconds();

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
            'feed' => $feed,
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
