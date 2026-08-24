<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\DartsAtlasRepository;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasConfig;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasHttpClient;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasParser;
use RuntimeException;
use Throwable;

final class DartsAtlasSyncService
{
    public function __construct(
        private readonly DartsAtlasHttpClient $http,
        private readonly DartsAtlasParser $parser,
        private readonly DartsAtlasRepository $repository,
        private readonly DartsAtlasConfig $config,
    ) {}

    /** @return array<string, mixed> */
    public function sync(?string $seasonId = null, ?string $tournamentId = null): array
    {
        $seasonId = trim((string) ($seasonId ?? $this->config->seasonId()));
        $tournamentId = trim((string) ($tournamentId ?? $this->config->tournamentId()));

        if ($seasonId === '') {
            throw new RuntimeException('DartsAtlas season id is required.');
        }

        if ($this->config->clubId() <= 0) {
            throw new RuntimeException('DartsAtlas club id must be configured.');
        }

        return $this->syncSeason($seasonId, $tournamentId !== '' ? $tournamentId : null);
    }

    /** @return array<string, mixed> */
    public function syncSeason(string $seasonExternalId, ?string $tournamentExternalId = null): array
    {
        $targeted = $tournamentExternalId !== null && trim($tournamentExternalId) !== '';
        $tournamentExternalId = $targeted ? trim((string) $tournamentExternalId) : null;
        $lockScope = $targeted
            ? 'tournament:' . $tournamentExternalId
            : 'season:' . $seasonExternalId;

        if (!$this->repository->acquireLock($lockScope)) {
            return [
                'mode' => $targeted ? 'live_tournament' : 'full_season',
                'skipped' => true,
                'reason' => 'sync_already_running',
                'season_external_id' => $seasonExternalId,
                'tournament_external_id' => $tournamentExternalId,
            ];
        }

        $jobId = $this->repository->startJob(
            $targeted ? 'live_tournament_sync' : 'season_sync',
            'season',
            $this->config->localSeasonId()
        );

        $summary = [
            'mode' => $targeted ? 'live_tournament' : 'full_season',
            'season_external_id' => $seasonExternalId,
            'tournament_external_id' => $tournamentExternalId,
            'resources_fetched' => 0,
            'resources_not_modified' => 0,
            'players_seen' => 0,
            'tournaments_seen' => 0,
            'matches_seen' => 0,
            'matches_mapped' => 0,
            'live_states_written' => 0,
            'warnings' => [],
        ];

        try {
            $playerMap = [];

            if ($targeted) {
                $tournaments = [[
                    'external_id' => $tournamentExternalId,
                    'name' => 'DartsAtlas ' . $tournamentExternalId,
                    'url' => "https://www.dartsatlas.com/tournaments/{$tournamentExternalId}",
                ]];
            } else {
                $seasonUrl = "https://www.dartsatlas.com/seasons/{$seasonExternalId}";
                $season = $this->fetchParsed(
                    'season',
                    $seasonExternalId,
                    $seasonUrl,
                    null,
                    fn (string $html): array => $this->parser->parseSeason($html, $seasonUrl),
                    $summary,
                ) ?? $this->repository->resourcePayload('season', $seasonExternalId);

                if ($season === null) {
                    throw new RuntimeException('Season page returned no parseable data.');
                }

                foreach (['results', 'calendar'] as $page) {
                    $pageUrl = $seasonUrl . '/tournaments/' . $page;
                    try {
                        $payload = $this->fetchParsed(
                            'season_' . $page,
                            $seasonExternalId,
                            $pageUrl,
                            $seasonExternalId,
                            fn (string $html): array => $this->parser->parseSeason($html, $seasonUrl),
                            $summary,
                        ) ?? $this->repository->resourcePayload('season_' . $page, $seasonExternalId);
                    } catch (Throwable $error) {
                        $summary['warnings'][] = "Season {$page} page could not be read: {$error->getMessage()}";
                        $payload = null;
                    }

                    if (is_array($payload)) {
                        $season['players'] = $this->mergeByExternalId($season['players'] ?? [], $payload['players'] ?? []);
                        $season['tournaments'] = $this->mergeByExternalId($season['tournaments'] ?? [], $payload['tournaments'] ?? []);
                    }
                }

                foreach ($season['players'] ?? [] as $player) {
                    if (is_array($player)) {
                        $this->registerPlayer($player, $playerMap, $summary);
                    }
                }

                $tournaments = is_array($season['tournaments'] ?? null) ? $season['tournaments'] : [];
            }

            foreach ($tournaments as $tournamentInfo) {
                if (!is_array($tournamentInfo)) {
                    continue;
                }

                $externalTournamentId = trim((string) ($tournamentInfo['external_id'] ?? ''));
                if ($externalTournamentId === '') {
                    continue;
                }

                $url = (string) ($tournamentInfo['url'] ?? "https://www.dartsatlas.com/tournaments/{$externalTournamentId}");
                $tournament = $this->fetchParsed(
                    'tournament',
                    $externalTournamentId,
                    $url,
                    $seasonExternalId,
                    fn (string $html): array => $this->parser->parseTournament($html, $url),
                    $summary,
                ) ?? $this->repository->resourcePayload('tournament', $externalTournamentId);

                if ($tournament === null) {
                    $summary['warnings'][] = "Tournament {$externalTournamentId} had no parseable payload.";
                    continue;
                }

                $tournamentName = trim((string) ($tournament['name'] ?? $tournamentInfo['name'] ?? $externalTournamentId));
                $tournamentStatus = $this->deriveTournamentStatus($tournament, $targeted);
                $localTournamentId = $this->repository->upsertTournament(
                    $this->config->clubId(),
                    $this->config->localSeasonId(),
                    $externalTournamentId,
                    $tournamentName !== '' ? $tournamentName : $externalTournamentId,
                    [
                        'source_url' => $url,
                        'season_external_id' => $seasonExternalId,
                        'external_id' => $externalTournamentId,
                    ],
                    $tournamentStatus,
                );
                $summary['tournaments_seen']++;

                foreach ($tournament['players'] ?? [] as $player) {
                    if (!is_array($player)) {
                        continue;
                    }
                    $playerId = $this->registerPlayer($player, $playerMap, $summary);
                    if ($playerId !== null) {
                        $this->repository->addTournamentPlayer($localTournamentId, $playerId, 'checked_in');
                    }
                }

                foreach ($tournament['matches'] ?? [] as $matchInfo) {
                    if (!is_array($matchInfo)) {
                        continue;
                    }
                    $summary['matches_seen']++;
                    $externalMatchId = trim((string) ($matchInfo['external_id'] ?? ''));
                    if ($externalMatchId === '') {
                        continue;
                    }

                    $matchPayload = null;
                    $isDerived = str_starts_with($externalMatchId, 'derived-');
                    $matchUrl = isset($matchInfo['url']) && is_string($matchInfo['url']) && trim($matchInfo['url']) !== ''
                        ? trim($matchInfo['url'])
                        : "https://www.dartsatlas.com/matches/{$externalMatchId}";

                    $snapshotStatus = (string) ($matchInfo['status'] ?? '');
                    $shouldFetchMatch = !$isDerived && (!$targeted || $snapshotStatus !== 'completed');

                    if ($shouldFetchMatch) {
                        try {
                            $matchPayload = $this->fetchParsed(
                                'match',
                                $externalMatchId,
                                $matchUrl,
                                $externalTournamentId,
                                fn (string $html): array => $this->parser->parseMatch($html, $matchUrl),
                                $summary,
                            ) ?? $this->repository->resourcePayload('match', $externalMatchId);
                        } catch (Throwable $error) {
                            $summary['warnings'][] = "Match {$externalMatchId} page failed; tournament snapshot retained.";
                        }
                    }

                    $matchPlayers = [];
                    foreach (['player_a', 'player_b'] as $key) {
                        if (!is_array($matchInfo[$key] ?? null)) {
                            continue;
                        }
                        $playerId = $this->registerPlayer($matchInfo[$key], $playerMap, $summary);
                        if ($playerId !== null) {
                            $matchPlayers[] = $playerId;
                            $this->repository->addTournamentPlayer($localTournamentId, $playerId, 'checked_in');
                        }
                    }

                    foreach ($matchPayload['players'] ?? [] as $player) {
                        if (!is_array($player)) {
                            continue;
                        }
                        $playerId = $this->registerPlayer($player, $playerMap, $summary);
                        if ($playerId !== null) {
                            $matchPlayers[] = $playerId;
                            $this->repository->addTournamentPlayer($localTournamentId, $playerId, 'checked_in');
                        }
                    }

                    $matchPlayers = array_values(array_unique($matchPlayers));
                    if (count($matchPlayers) < 2) {
                        $summary['warnings'][] = "Match {$externalMatchId} discovered, but two players could not be identified.";
                        continue;
                    }

                    $localMatchId = $this->repository->upsertMatch(
                        $localTournamentId,
                        $externalMatchId,
                        $matchPlayers[0],
                        $matchPlayers[1],
                        [
                            'source_url' => $isDerived ? $url : $matchUrl,
                            'provider' => 'dartsatlas',
                            'external_id' => $externalMatchId,
                        ],
                    );
                    $summary['matches_mapped']++;

                    if (
                        array_key_exists('status', $matchInfo)
                        || array_key_exists('player_a_legs', $matchInfo)
                        || array_key_exists('average_a', $matchInfo)
                    ) {
                        $this->repository->applyMatchSnapshot($localMatchId, $this->config->clubId(), $matchInfo);
                        $summary['live_states_written']++;
                    }

                    if (is_array($matchPayload['live'] ?? null)) {
                        $this->repository->applyBroadcastState($localMatchId, $matchPayload['live'], $playerMap);
                        $summary['live_states_written']++;
                    }

                    $shouldFetchBroadcast = !$isDerived && (!$targeted || $snapshotStatus !== 'completed');
                    if ($shouldFetchBroadcast) {
                        $broadcastUrl = $matchUrl . '/broadcast?mode=dual_cam_stats';
                        try {
                            $broadcast = $this->fetchParsed(
                                'match_broadcast',
                                $externalMatchId,
                                $broadcastUrl,
                                $externalTournamentId,
                                fn (string $html): array => $this->parser->parseBroadcast($html, $externalMatchId),
                                $summary,
                            ) ?? $this->repository->resourcePayload('match_broadcast', $externalMatchId);

                            if (is_array($broadcast)) {
                                $this->repository->applyBroadcastState($localMatchId, $broadcast, $playerMap);
                                $summary['live_states_written']++;
                            }
                        } catch (Throwable) {
                            $summary['warnings'][] = "Broadcast for {$externalMatchId} unavailable; base match data kept.";
                        }
                    }
                }
            }

            $summary['member_links'] = $this->repository->memberLinkSummary($this->config->clubId());
            $this->repository->finishJob($jobId, $summary);
            return $summary;
        } catch (Throwable $error) {
            $this->repository->failJob($jobId, $error, $summary);
            throw $error;
        } finally {
            $this->repository->releaseLock($lockScope);
        }
    }

    /** @param array<string, mixed> $tournament */
    private function deriveTournamentStatus(array $tournament, bool $targeted): string
    {
        if (!$targeted) {
            return 'ready';
        }

        $statuses = [];
        foreach ($tournament['matches'] ?? [] as $match) {
            if (!is_array($match)) {
                continue;
            }
            $status = trim((string) ($match['status'] ?? ''));
            if ($status !== '') {
                $statuses[] = $status;
            }
        }

        if (in_array('in_progress', $statuses, true)) {
            return 'in_progress';
        }

        if ($statuses !== [] && count(array_filter(
            $statuses,
            static fn (string $status): bool => $status === 'completed'
        )) === count($statuses)) {
            return 'completed';
        }

        return 'ready';
    }

    /**
     * @param array<string, mixed> $player
     * @param array<string, int> $playerMap
     * @param array<string, mixed> $summary
     */
    private function registerPlayer(array $player, array &$playerMap, array &$summary): ?int
    {
        $externalId = trim((string) ($player['external_id'] ?? ''));
        $name = trim((string) ($player['name'] ?? ''));

        if ($externalId === '' || $name === '') {
            return null;
        }

        if (!isset($playerMap[$externalId])) {
            $playerMap[$externalId] = $this->repository->upsertPlayer($this->config->clubId(), $externalId, $name);
            $summary['players_seen']++;
        }

        return $playerMap[$externalId];
    }

    /**
     * @param callable(string): array<string, mixed> $parse
     * @param array<string, mixed> $summary
     * @return array<string, mixed>|null
     */
    private function fetchParsed(
        string $resourceType,
        string $externalId,
        string $url,
        ?string $parentExternalId,
        callable $parse,
        array &$summary,
    ): ?array {
        $cache = $this->repository->resourceCache($resourceType, $externalId);
        $response = $this->http->get(
            $url,
            isset($cache['etag']) ? (string) $cache['etag'] : null,
            isset($cache['last_modified']) ? (string) $cache['last_modified'] : null,
        );

        if ($response->status === 304) {
            $summary['resources_not_modified']++;
            $cached = $this->repository->resourcePayload($resourceType, $externalId) ?? [];
            $this->repository->upsertResource(
                $resourceType,
                $externalId,
                $url,
                304,
                $response->header('etag') ?? ($cache['etag'] ?? null),
                $response->header('last-modified') ?? ($cache['last_modified'] ?? null),
                isset($cache['content_hash']) ? (string) $cache['content_hash'] : null,
                $parentExternalId,
                $cached,
                false,
            );
            return null;
        }

        $summary['resources_fetched']++;
        $hash = hash('sha256', $response->body);
        $changed = !isset($cache['content_hash']) || (string) $cache['content_hash'] !== $hash;
        $payload = $parse($response->body);

        $this->repository->upsertResource(
            $resourceType,
            $externalId,
            $response->url,
            $response->status,
            $response->header('etag'),
            $response->header('last-modified'),
            $hash,
            $parentExternalId,
            $payload,
            $changed,
        );

        return $payload;
    }

    /** @param array<int, mixed> $left @param array<int, mixed> $right @return array<int, array<string, mixed>> */
    private function mergeByExternalId(array $left, array $right): array
    {
        $merged = [];

        foreach (array_merge($left, $right) as $item) {
            if (!is_array($item)) {
                continue;
            }
            $id = trim((string) ($item['external_id'] ?? ''));
            if ($id === '') {
                continue;
            }
            $merged[$id] = array_merge($merged[$id] ?? [], $item);
        }

        return array_values($merged);
    }
}
