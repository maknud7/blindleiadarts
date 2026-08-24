<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
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

$decodeMetadata = static function (?string $value): array {
    if ($value === null || $value === '') {
        return [];
    }

    $decoded = json_decode($value, true);
    return is_array($decoded) ? $decoded : [];
};

$nullableInt = static fn (mixed $value): ?int => $value === null || $value === '' ? null : (int) $value;
$nullableFloat = static fn (mixed $value): ?float => $value === null || $value === '' ? null : (float) $value;

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $prefix = $database->tablePrefix();

    $requested = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $tournamentId = is_int($requested) && $requested > 0 ? $requested : 0;
    if ($tournamentId <= 0) {
        $respond([
            'ok' => false,
            'error' => [
                'code' => 'tournament_required',
                'message' => 'tournament_id is required.',
            ],
        ], 422);
    }

    $clubId = $config->dartsAtlas()->clubId();
    if ($clubId <= 0) {
        $slug = trim($config->screenDefaultClubSlug());
        $clubs = $prefix . 'clubs';
        if ($slug === '') {
            throw new RuntimeException('Could not resolve public DartsAtlas club.');
        }
        $statement = $db->prepare("SELECT id FROM `{$clubs}` WHERE slug = ? LIMIT 1");
        $statement->bind_param('s', $slug);
        $statement->execute();
        $club = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        if ($club === null) {
            throw new RuntimeException('Configured DartsAtlas club was not found.');
        }
        $clubId = (int) $club['id'];
    }

    $tournaments = $prefix . 'tournaments';
    $references = $prefix . 'external_references';
    $statement = $db->prepare(
        "SELECT t.id, t.name, t.status, er.external_id
         FROM `{$tournaments}` t
         LEFT JOIN `{$references}` er
           ON er.external_system='dartsatlas'
          AND er.external_entity_type='tournament'
          AND er.internal_entity_type='tournament'
          AND er.internal_id=t.id
         WHERE t.id = ? AND t.club_id = ? AND t.provider_system = 'dartsatlas'
         LIMIT 1"
    );
    $statement->bind_param('ii', $tournamentId, $clubId);
    $statement->execute();
    $tournament = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($tournament === null) {
        $respond([
            'ok' => false,
            'error' => [
                'code' => 'tournament_not_found',
                'message' => 'DartsAtlas tournament was not found.',
            ],
        ], 404);
    }

    /*
     * The normal connector historically parsed only the tournament landing page.
     * During group play DartsAtlas can keep the actual match rows on a child tab,
     * while /groups continues to update. If the tournament is in progress, probe
     * the landing page plus any discovered match/group/result/bracket tabs and
     * persist the parsed snapshots into the canonical connector tables.
     *
     * This scan is throttled to five seconds and protected by the connector lock,
     * so a 2-second browser poll cannot fan out into parallel DartsAtlas scrapes.
     */
    $direct = [
        'attempted' => false,
        'status' => 'not_needed',
        'pages' => [],
        'matches_found' => 0,
        'matches_persisted' => 0,
    ];

    $externalTournamentId = trim((string) ($tournament['external_id'] ?? ''));
    if ((string) $tournament['status'] === 'in_progress' && $externalTournamentId !== '') {
        $resources = $prefix . 'connector_resources';
        $scanType = 'public_match_scan';
        $ageStatement = $db->prepare(
            "SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS age_seconds
             FROM `{$resources}`
             WHERE external_system='dartsatlas' AND resource_type=? AND external_id=?
             LIMIT 1"
        );
        $ageStatement->bind_param('ss', $scanType, $externalTournamentId);
        $ageStatement->execute();
        $ageRow = $ageStatement->get_result()->fetch_assoc() ?: [];
        $ageStatement->close();
        $scanAge = isset($ageRow['age_seconds']) ? (int) $ageRow['age_seconds'] : null;

        if ($scanAge === null || $scanAge >= 5) {
            $repository = new DartsAtlasRepository($database, $config->dartsAtlas()->membersTable());
            $lockScope = 'public-match-scan:' . $externalTournamentId;
            if ($repository->acquireLock($lockScope)) {
                $direct['attempted'] = true;
                $direct['status'] = 'completed';
                try {
                    $http = new DartsAtlasHttpClient($config->dartsAtlas()->userAgent(), 4, 10);
                    $parser = new DartsAtlasParser();
                    $baseUrl = 'https://www.dartsatlas.com/tournaments/' . rawurlencode($externalTournamentId);
                    $queue = [$baseUrl];
                    foreach (['groups', 'results', 'matches', 'bracket', 'brackets', 'fixtures'] as $suffix) {
                        $queue[] = $baseUrl . '/' . $suffix;
                    }

                    $seenUrls = [];
                    $parsedMatches = [];
                    $playerMap = [];

                    while ($queue !== [] && count($seenUrls) < 12) {
                        $url = array_shift($queue);
                        if (!is_string($url) || $url === '' || isset($seenUrls[$url])) {
                            continue;
                        }
                        $seenUrls[$url] = true;

                        try {
                            $response = $http->get($url);
                            $payload = $parser->parseTournament($response->body, $baseUrl);
                            $pageMatches = is_array($payload['matches'] ?? null) ? $payload['matches'] : [];
                            $direct['pages'][] = [
                                'url' => $response->url,
                                'status' => $response->status,
                                'matches' => count($pageMatches),
                            ];

                            foreach ($pageMatches as $match) {
                                if (!is_array($match)) {
                                    continue;
                                }
                                $matchExternalId = trim((string) ($match['external_id'] ?? ''));
                                if ($matchExternalId === '') {
                                    continue;
                                }
                                $parsedMatches[$matchExternalId] = array_merge($parsedMatches[$matchExternalId] ?? [], $match);
                            }

                            if (preg_match_all('/href=["\']([^"\']+)["\']/iu', $response->body, $hrefMatches)) {
                                foreach ($hrefMatches[1] as $href) {
                                    $href = html_entity_decode((string) $href, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                                    if (!preg_match('~^/tournaments/' . preg_quote($externalTournamentId, '~') . '/([^?#]+)~u', $href, $pathMatch)) {
                                        continue;
                                    }
                                    $tail = strtolower((string) $pathMatch[1]);
                                    if (!preg_match('/group|result|match|bracket|fixture|round/u', $tail)) {
                                        continue;
                                    }
                                    $queue[] = 'https://www.dartsatlas.com' . $href;
                                }
                            }
                        } catch (Throwable $pageError) {
                            $direct['pages'][] = [
                                'url' => $url,
                                'status' => 'unavailable',
                            ];
                        }
                    }

                    $direct['matches_found'] = count($parsedMatches);

                    foreach ($parsedMatches as $matchExternalId => $match) {
                        $playerA = is_array($match['player_a'] ?? null) ? $match['player_a'] : null;
                        $playerB = is_array($match['player_b'] ?? null) ? $match['player_b'] : null;
                        if ($playerA === null || $playerB === null) {
                            continue;
                        }

                        $externalA = trim((string) ($playerA['external_id'] ?? ''));
                        $externalB = trim((string) ($playerB['external_id'] ?? ''));
                        $nameA = trim((string) ($playerA['name'] ?? ''));
                        $nameB = trim((string) ($playerB['name'] ?? ''));
                        if ($externalA === '' || $externalB === '' || $nameA === '' || $nameB === '') {
                            continue;
                        }

                        if (!isset($playerMap[$externalA])) {
                            $playerMap[$externalA] = $repository->upsertPlayer($clubId, $externalA, $nameA);
                        }
                        if (!isset($playerMap[$externalB])) {
                            $playerMap[$externalB] = $repository->upsertPlayer($clubId, $externalB, $nameB);
                        }
                        $repository->addTournamentPlayer($tournamentId, $playerMap[$externalA]);
                        $repository->addTournamentPlayer($tournamentId, $playerMap[$externalB]);

                        $matchUrl = isset($match['url']) && is_string($match['url']) && trim($match['url']) !== ''
                            ? trim($match['url'])
                            : null;
                        $localMatchId = $repository->upsertMatch(
                            $tournamentId,
                            (string) $matchExternalId,
                            $playerMap[$externalA],
                            $playerMap[$externalB],
                            [
                                'source_url' => $matchUrl,
                                'provider' => 'dartsatlas',
                                'external_id' => (string) $matchExternalId,
                                'board_number' => $match['board_number'] ?? null,
                                'fallback_scan' => true,
                            ],
                        );
                        $repository->applyMatchSnapshot($localMatchId, $clubId, $match);
                        $direct['matches_persisted']++;

                        if (($match['status'] ?? null) === 'in_progress' && $matchUrl !== null && !str_starts_with((string) $matchExternalId, 'derived-')) {
                            try {
                                $matchResponse = $http->get($matchUrl);
                                $matchPayload = $parser->parseMatch($matchResponse->body, $matchUrl);
                                if (is_array($matchPayload['live'] ?? null)) {
                                    $repository->applyBroadcastState($localMatchId, $matchPayload['live'], $playerMap);
                                }
                            } catch (Throwable) {
                                // Tournament snapshot is still useful without the match detail page.
                            }

                            try {
                                $broadcastUrl = rtrim($matchUrl, '/') . '/broadcast?mode=dual_cam_stats';
                                $broadcastResponse = $http->get($broadcastUrl);
                                $broadcast = $parser->parseBroadcast($broadcastResponse->body, (string) $matchExternalId);
                                $repository->applyBroadcastState($localMatchId, $broadcast, $playerMap);
                            } catch (Throwable) {
                                // Live score/statistics enrichment is optional.
                            }
                        }
                    }

                    $repository->upsertResource(
                        $scanType,
                        $externalTournamentId,
                        $baseUrl,
                        200,
                        null,
                        null,
                        hash('sha256', json_encode($direct, JSON_THROW_ON_ERROR)),
                        $externalTournamentId,
                        $direct,
                        true,
                    );
                } catch (Throwable $scanError) {
                    $direct['status'] = 'failed';
                    if ($config->appEnv() !== 'prod') {
                        $direct['error'] = $scanError->getMessage();
                    }
                } finally {
                    $repository->releaseLock($lockScope);
                }
            } else {
                $direct['status'] = 'sync_already_running';
            }
        } else {
            $direct['status'] = 'throttled';
            $direct['cache_age_seconds'] = $scanAge;
        }
    }

    $matches = $prefix . 'matches';
    $players = $prefix . 'players';
    $liveStates = $prefix . 'live_match_states';
    $statistics = $prefix . 'match_statistics';

    $liveSql = "SELECT
            m.id,
            m.status,
            m.round_label,
            m.bracket_label,
            m.best_of_legs,
            m.legs_to_win,
            m.player_a_id,
            pa.display_name AS player_a_name,
            m.player_b_id,
            pb.display_name AS player_b_name,
            m.winner_player_id,
            m.provider_metadata,
            m.starts_at,
            lms.player_a_score,
            lms.player_b_score,
            lms.player_a_legs,
            lms.player_b_legs,
            lms.throwing_player_id,
            lms.provider_status,
            lms.provider_updated_at,
            sa.average AS player_a_average,
            sa.first_nine_average AS player_a_first_nine,
            sa.highest_checkout AS player_a_highest_checkout,
            sa.score_180 AS player_a_180,
            sb.average AS player_b_average,
            sb.first_nine_average AS player_b_first_nine,
            sb.highest_checkout AS player_b_highest_checkout,
            sb.score_180 AS player_b_180
        FROM `{$matches}` m
        INNER JOIN `{$players}` pa ON pa.id = m.player_a_id
        INNER JOIN `{$players}` pb ON pb.id = m.player_b_id
        LEFT JOIN `{$liveStates}` lms ON lms.match_id = m.id
        LEFT JOIN `{$statistics}` sa ON sa.match_id = m.id AND sa.player_id = m.player_a_id
        LEFT JOIN `{$statistics}` sb ON sb.match_id = m.id AND sb.player_id = m.player_b_id
        WHERE m.tournament_id = ? AND m.status = 'in_progress'
        ORDER BY COALESCE(m.starts_at, m.updated_at) ASC, m.id ASC";

    $statement = $db->prepare($liveSql);
    $statement->bind_param('i', $tournamentId);
    $statement->execute();
    $liveRows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
    $statement->close();

    $formatLive = static function (array $row) use ($decodeMetadata, $nullableInt, $nullableFloat): array {
        $metadata = $decodeMetadata(isset($row['provider_metadata']) ? (string) $row['provider_metadata'] : null);
        $boardNumber = $metadata['board_number'] ?? null;
        $boardNumber = is_numeric($boardNumber) ? (int) $boardNumber : null;

        return [
            'id' => (int) $row['id'],
            'status' => (string) $row['status'],
            'round_label' => $row['round_label'] ?? null,
            'bracket_label' => $row['bracket_label'] ?? null,
            'best_of_legs' => (int) $row['best_of_legs'],
            'legs_to_win' => (int) $row['legs_to_win'],
            'provider_board_number' => $boardNumber,
            'starts_at' => $row['starts_at'] ?? null,
            'current_player_id' => $nullableInt($row['throwing_player_id'] ?? null),
            'provider_status' => $row['provider_status'] ?? null,
            'provider_updated_at' => $row['provider_updated_at'] ?? null,
            'player_a' => [
                'id' => (int) $row['player_a_id'],
                'display_name' => (string) $row['player_a_name'],
                'remaining' => $nullableInt($row['player_a_score'] ?? null),
                'legs_won' => $nullableInt($row['player_a_legs'] ?? null) ?? 0,
                'average' => $nullableFloat($row['player_a_average'] ?? null),
                'first_nine_average' => $nullableFloat($row['player_a_first_nine'] ?? null),
                'highest_checkout' => $nullableInt($row['player_a_highest_checkout'] ?? null),
                'score_180' => $nullableInt($row['player_a_180'] ?? null) ?? 0,
            ],
            'player_b' => [
                'id' => (int) $row['player_b_id'],
                'display_name' => (string) $row['player_b_name'],
                'remaining' => $nullableInt($row['player_b_score'] ?? null),
                'legs_won' => $nullableInt($row['player_b_legs'] ?? null) ?? 0,
                'average' => $nullableFloat($row['player_b_average'] ?? null),
                'first_nine_average' => $nullableFloat($row['player_b_first_nine'] ?? null),
                'highest_checkout' => $nullableInt($row['player_b_highest_checkout'] ?? null),
                'score_180' => $nullableInt($row['player_b_180'] ?? null) ?? 0,
            ],
        ];
    };

    $recentSql = "SELECT
            m.id,
            m.round_label,
            m.bracket_label,
            m.player_a_id,
            pa.display_name AS player_a_name,
            m.player_b_id,
            pb.display_name AS player_b_name,
            m.winner_player_id,
            pw.display_name AS winner_name,
            m.provider_metadata,
            m.finished_at,
            sa.legs_won AS player_a_legs,
            sb.legs_won AS player_b_legs
        FROM `{$matches}` m
        INNER JOIN `{$players}` pa ON pa.id = m.player_a_id
        INNER JOIN `{$players}` pb ON pb.id = m.player_b_id
        LEFT JOIN `{$players}` pw ON pw.id = m.winner_player_id
        LEFT JOIN `{$statistics}` sa ON sa.match_id = m.id AND sa.player_id = m.player_a_id
        LEFT JOIN `{$statistics}` sb ON sb.match_id = m.id AND sb.player_id = m.player_b_id
        WHERE m.tournament_id = ? AND m.status = 'completed'
        ORDER BY COALESCE(m.finished_at, m.updated_at) DESC, m.id DESC
        LIMIT 8";

    $statement = $db->prepare($recentSql);
    $statement->bind_param('i', $tournamentId);
    $statement->execute();
    $recentRows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
    $statement->close();

    $recentResults = array_map(static function (array $row) use ($decodeMetadata, $nullableInt): array {
        $metadata = $decodeMetadata(isset($row['provider_metadata']) ? (string) $row['provider_metadata'] : null);
        $boardNumber = $metadata['board_number'] ?? null;
        return [
            'id' => (int) $row['id'],
            'round_label' => $row['round_label'] ?? null,
            'bracket_label' => $row['bracket_label'] ?? null,
            'provider_board_number' => is_numeric($boardNumber) ? (int) $boardNumber : null,
            'player_a_name' => (string) $row['player_a_name'],
            'player_b_name' => (string) $row['player_b_name'],
            'player_a_legs' => $nullableInt($row['player_a_legs'] ?? null),
            'player_b_legs' => $nullableInt($row['player_b_legs'] ?? null),
            'winner_player_id' => $nullableInt($row['winner_player_id'] ?? null),
            'winner_name' => $row['winner_name'] ?? null,
            'finished_at' => $row['finished_at'] ?? null,
        ];
    }, $recentRows);

    $respond([
        'ok' => true,
        'generated_at' => gmdate('c'),
        'data' => [
            'tournament' => [
                'id' => (int) $tournament['id'],
                'name' => (string) $tournament['name'],
                'status' => (string) $tournament['status'],
            ],
            'live_matches' => array_map($formatLive, $liveRows),
            'recent_results' => $recentResults,
            'direct_sync' => $direct,
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'dartsatlas_public_matches_unavailable',
            'message' => 'Public DartsAtlas match data is not available.',
            'detail' => isset($config) && $config->appEnv() === 'prod' ? null : $error->getMessage(),
        ],
    ], 503);
}
