<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Repository\DartsAtlasScreenRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Service\DartsAtlasSyncService;
use Blindleia\Dartkiosk\Api\Service\PublicLiveInsights;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

$stage = 'bootstrap';

try {
    $stage = 'config';
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $dartsAtlas = $config->dartsAtlas();

    $stage = 'club';
    $clubId = $dartsAtlas->clubId();
    if ($clubId <= 0) {
        $clubsTable = $prefix . 'clubs';
        $slug = trim($config->screenDefaultClubSlug());
        $club = null;

        if ($slug !== '') {
            $statement = $db->prepare("SELECT id FROM `{$clubsTable}` WHERE slug = ? LIMIT 1");
            $statement->bind_param('s', $slug);
            $statement->execute();
            $club = $statement->get_result()->fetch_assoc() ?: null;
            $statement->close();
        } elseif ($config->appEnv() !== 'prod') {
            $result = $db->query("SELECT id FROM `{$clubsTable}` ORDER BY id ASC LIMIT 1");
            $club = $result->fetch_assoc() ?: null;
            $result->free();
        }

        if (!$club) {
            throw new RuntimeException('Could not resolve DartsAtlas club. Configure club_id or screen.default_club_slug.');
        }

        $clubId = (int) $club['id'];
        $dartsAtlas = $dartsAtlas->withClubId($clubId);
    }

    $stage = 'season';
    if ($dartsAtlas->localSeasonId() === null) {
        $seasonsTable = $prefix . 'seasons';
        $statement = $db->prepare(
            "SELECT id FROM `{$seasonsTable}` WHERE club_id = ? ORDER BY is_active DESC, id DESC LIMIT 1"
        );
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $season = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        if ($season) {
            $dartsAtlas = $dartsAtlas->withLocalSeasonId((int) $season['id']);
        }
    }

    $sync = static function (string $seasonExternalId, ?string $tournamentExternalId = null) use (
        $config,
        $database,
        $dartsAtlas
    ): array {
        $membership = new MembershipDatabase($config, $database, $dartsAtlas->membersTable());
        $memberRegistrySource = $membership->prepareRepositoryBridge();
        $repository = new DartsAtlasRepository($database, $dartsAtlas->membersTable());
        $service = new DartsAtlasSyncService(
            new DartsAtlasHttpClient($dartsAtlas->userAgent()),
            new DartsAtlasParser(),
            $repository,
            $dartsAtlas,
        );
        $summary = $service->syncSeason($seasonExternalId, $tournamentExternalId);
        $summary['member_registry_source'] = $memberRegistrySource;
        return $summary;
    };

    $findTournament = static function (?int $requestedTournamentId = null) use ($db, $prefix, $clubId): ?array {
        $tournaments = $prefix . 'tournaments';
        $clubs = $prefix . 'clubs';
        $matches = $prefix . 'matches';
        $references = $prefix . 'external_references';
        $resources = $prefix . 'connector_resources';

        $baseSelect = "SELECT t.id, t.name, t.status, t.season_id, t.provider_system, t.provider_metadata,
                c.name AS club_name, c.logo_url AS club_logo_url,
                (SELECT COUNT(*) FROM `{$matches}` lm
                 WHERE lm.tournament_id = t.id AND lm.status = 'in_progress') AS live_match_count,
                (SELECT COUNT(*) FROM `{$matches}` om
                 WHERE om.tournament_id = t.id AND om.status IN ('assigned', 'pending')) AS open_match_count,
                (SELECT MAX(cr.last_changed_at)
                 FROM `{$references}` er
                 INNER JOIN `{$resources}` cr
                   ON cr.external_system = 'dartsatlas'
                  AND cr.resource_type = 'tournament'
                  AND cr.external_id = er.external_id
                 WHERE er.external_system = 'dartsatlas'
                   AND er.external_entity_type = 'tournament'
                   AND er.internal_entity_type = 'tournament'
                   AND er.internal_id = t.id) AS provider_changed_at
            FROM `{$tournaments}` t
            INNER JOIN `{$clubs}` c ON c.id = t.club_id";

        if ($requestedTournamentId !== null) {
            $statement = $db->prepare(
                $baseSelect . "
                 WHERE t.id = ? AND t.club_id = ? AND t.provider_system = 'dartsatlas'
                 LIMIT 1"
            );
            $statement->bind_param('ii', $requestedTournamentId, $clubId);
        } else {
            $statement = $db->prepare(
                $baseSelect . "
                 WHERE t.club_id = ? AND t.provider_system = 'dartsatlas'
                 ORDER BY live_match_count DESC,
                          CASE WHEN open_match_count > 0 THEN 0 ELSE 1 END,
                          FIELD(t.status, 'in_progress', 'ready', 'completed', 'archived'),
                          provider_changed_at DESC,
                          COALESCE(t.start_at, t.updated_at) DESC,
                          t.id DESC
                 LIMIT 1"
            );
            $statement->bind_param('i', $clubId);
        }

        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        return $row;
    };

    $stage = 'tournament_discovery';
    $requestedTournament = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $requestedTournamentId = is_int($requestedTournament) && $requestedTournament > 0
        ? $requestedTournament
        : null;

    $tournament = $findTournament($requestedTournamentId);
    $bootstrap = [
        'attempted' => false,
        'status' => 'not_needed',
    ];

    $seasonExternalId = trim($dartsAtlas->seasonId());
    if ($requestedTournamentId === null && $seasonExternalId !== '') {
        $hasOpenTournament = $tournament !== null
            && (((int) ($tournament['live_match_count'] ?? 0)) > 0 || ((int) ($tournament['open_match_count'] ?? 0)) > 0);

        $jobsTable = $prefix . 'connector_sync_jobs';
        $lastSeasonSync = null;
        $result = $db->query(
            "SELECT MAX(finished_at) AS finished_at FROM `{$jobsTable}`
             WHERE external_system = 'dartsatlas'
               AND job_type = 'season_sync'
               AND status = 'completed'"
        );
        if ($result !== false) {
            $row = $result->fetch_assoc() ?: [];
            $lastSeasonSync = $row['finished_at'] ?? null;
            $result->free();
        }
        $seasonSyncAge = $lastSeasonSync !== null ? max(0, time() - strtotime((string) $lastSeasonSync)) : null;
        $discoveryDue = $tournament === null || (!$hasOpenTournament && ($seasonSyncAge === null || $seasonSyncAge >= 180));

        if ($discoveryDue) {
            $bootstrap['attempted'] = true;
            try {
                $summary = $sync($seasonExternalId, null);
                $bootstrap['status'] = 'completed';
                $bootstrap['summary'] = [
                    'tournaments_seen' => (int) ($summary['tournaments_seen'] ?? 0),
                    'matches_seen' => (int) ($summary['matches_seen'] ?? 0),
                    'member_registry_source' => $summary['member_registry_source'] ?? 'unavailable',
                ];
                $tournament = $findTournament(null);
            } catch (Throwable $bootstrapError) {
                $bootstrap['status'] = 'failed';
                $bootstrap['error_code'] = 'season_sync_failed';
                if ($config->appEnv() !== 'prod') {
                    $bootstrap['error'] = $bootstrapError->getMessage();
                }
            }
        }
    }

    if ($tournament === null) {
        $respond([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'data' => [
                'club_id' => $clubId,
                'tournament' => null,
                'feed' => [
                    'provider' => 'dartsatlas',
                    'status' => $bootstrap['status'] === 'failed' ? 'error' : 'idle',
                    'bootstrap' => $bootstrap,
                    'poll_interval_seconds' => $dartsAtlas->pollIntervalSeconds(),
                ],
                'next_matches' => [],
                'standings' => [],
                'stats' => [
                    'highlights' => [],
                    'best_match_averages' => [],
                    'top_visits' => [],
                    'live_elo' => ['baseline' => 1000, 'k_factor' => 32, 'table' => [], 'changes' => []],
                ],
            ],
        ]);
    }

    $stage = 'tournament_feed';
    $tournamentId = (int) $tournament['id'];
    $screenRepository = new DartsAtlasScreenRepository($database);
    $tournamentRepository = new TournamentRepository($database);
    $insights = new PublicLiveInsights($database);

    try {
        $feed = $screenRepository->feedStatus($tournamentId);
    } catch (Throwable) {
        $feed = [
            'provider' => 'dartsatlas',
            'status' => 'error',
            'last_seen_at' => null,
            'age_seconds' => null,
            'warnings' => ['feed_status_unavailable'],
        ];
    }

    $feedAge = isset($feed['age_seconds']) && is_numeric($feed['age_seconds'])
        ? (int) $feed['age_seconds']
        : null;

    $refreshAttempted = false;
    $refreshSkipped = null;
    $memberRegistrySource = $bootstrap['summary']['member_registry_source'] ?? 'not_checked';
    $canRefresh = in_array((string) $tournament['status'], ['ready', 'in_progress'], true);
    $refreshDue = $canRefresh && ($feedAge === null || $feedAge >= $dartsAtlas->pollIntervalSeconds());

    if ($refreshDue) {
        $references = $prefix . 'external_references';
        $statement = $db->prepare(
            "SELECT external_id FROM `{$references}`
             WHERE external_system='dartsatlas'
               AND external_entity_type='tournament'
               AND internal_entity_type='tournament'
               AND internal_id=? LIMIT 1"
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
        $refreshSeasonExternalId = $seasonExternalId;
        if ($refreshSeasonExternalId === '') {
            $refreshSeasonExternalId = trim((string) ($metadata['season_external_id'] ?? ''));
        }

        if ($externalTournamentId === '') {
            $refreshSkipped = 'missing_external_tournament_id';
        } elseif ($refreshSeasonExternalId === '') {
            $refreshSkipped = 'missing_external_season_id';
        } else {
            $refreshAttempted = true;
            try {
                $summary = $sync($refreshSeasonExternalId, $externalTournamentId);
                $memberRegistrySource = (string) ($summary['member_registry_source'] ?? $memberRegistrySource);
                if (($summary['skipped'] ?? false) === true) {
                    $refreshSkipped = (string) ($summary['reason'] ?? 'sync_skipped');
                }
            } catch (Throwable) {
                $refreshSkipped = 'refresh_failed';
            }
            try {
                $feed = $screenRepository->feedStatus($tournamentId);
            } catch (Throwable) {
                $feed['status'] = 'error';
                $feed['warnings'][] = 'feed_status_refresh_unavailable';
            }
            $tournament = $findTournament($tournamentId) ?? $tournament;
        }
    }

    $feed['refresh_attempted'] = $refreshAttempted;
    $feed['poll_interval_seconds'] = $dartsAtlas->pollIntervalSeconds();
    $feed['member_registry_source'] = $memberRegistrySource;
    $feed['bootstrap'] = $bootstrap;
    if ($refreshSkipped !== null) {
        $feed['refresh_skipped'] = $refreshSkipped;
    }

    $stage = 'audience_enrichment';
    $warnings = is_array($feed['warnings'] ?? null) ? $feed['warnings'] : [];
    $safe = static function (string $code, callable $callback, mixed $fallback) use (&$warnings): mixed {
        try {
            return $callback();
        } catch (Throwable) {
            $warnings[] = $code;
            return $fallback;
        }
    };

    $seasonId = $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null;
    $nextMatches = $safe('next_matches_unavailable', fn () => $tournamentRepository->listUpcomingMatchesByTournamentId($tournamentId, 8), []);
    $standings = $safe('standings_unavailable', fn () => $screenRepository->listStandingsByTournamentId($tournamentId, 8), []);
    $highlights = $safe('highlights_unavailable', fn () => $screenRepository->highlights($tournamentId), []);
    $bestAverages = $safe('best_averages_unavailable', fn () => $screenRepository->listBestMatchAveragesByTournamentId($tournamentId, 5), []);
    $topVisits = $safe('top_visits_unavailable', fn () => $insights->topVisitBuckets($tournamentId, 5), []);
    $liveElo = $safe(
        'live_elo_unavailable',
        fn () => $insights->liveElo($tournamentId, $seasonId, 20),
        ['baseline' => 1000, 'k_factor' => 32, 'table' => [], 'changes' => []]
    );
    $feed['warnings'] = array_values(array_unique($warnings));

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
                'season_id' => $seasonId,
                'provider_system' => 'dartsatlas',
            ],
            'feed' => $feed,
            'next_matches' => $nextMatches,
            'standings' => $standings,
            'stats' => [
                'highlights' => $highlights,
                'best_match_averages' => $bestAverages,
                'top_visits' => $topVisits,
                'live_elo' => $liveElo,
            ],
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_public_live_unavailable',
            'message' => 'Live data is temporarily unavailable.',
            'stage' => $stage,
            'detail' => isset($config) && $config->appEnv() === 'prod' ? null : $error->getMessage(),
        ],
    ], 503);
}
