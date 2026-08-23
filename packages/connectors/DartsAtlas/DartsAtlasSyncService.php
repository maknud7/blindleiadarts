<?php

declare(strict_types=1);

final class DartsAtlasSyncService
{
    public function __construct(
        private readonly DartsAtlasHttpClient $http,
        private readonly DartsAtlasHtmlParser $parser,
        private readonly DartsAtlasRepository $repository,
        private readonly int $clubId,
        private readonly ?int $localSeasonId = null,
    ) {}

    public function syncSeason(string $seasonExternalId, ?string $tournamentExternalId = null): array
    {
        $targeted = $tournamentExternalId !== null && $tournamentExternalId !== '';
        $lockName = $targeted
            ? 'tournament:' . $tournamentExternalId
            : 'season:' . $seasonExternalId;

        if (!$this->repository->acquireLock($lockName)) {
            return [
                'mode' => $targeted ? 'live_tournament' : 'full_season',
                'skipped' => true,
                'reason' => 'sync_already_running',
                'season_external_id' => $seasonExternalId,
                'tournament_external_id' => $tournamentExternalId,
            ];
        }

        $jobId = $this->repository->startJob($targeted ? 'live_tournament_sync' : 'season_sync', 'season', $this->localSeasonId);
        $summary = [
            'mode' => $targeted ? 'live_tournament' : 'full_season',
            'season_external_id' => $seasonExternalId,
            'tournament_external_id' => $targeted ? $tournamentExternalId : null,
            'resources_fetched' => 0,
            'resources_not_modified' => 0,
            'players_seen' => 0,
            'tournaments_seen' => 0,
            'matches_seen' => 0,
            'matches_mapped' => 0,
            'match_pages_polled' => 0,
            'broadcasts_polled' => 0,
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
                    fn(string $html) => $this->parser->parseSeason($html, $seasonUrl),
                    $summary,
                ) ?? $this->cachedPayload('season', $seasonExternalId);

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
                            fn(string $html) => $this->parser->parseSeason($html, $seasonUrl),
                            $summary,
                        ) ?? $this->cachedPayload('season_' . $page, $seasonExternalId);
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
                    $this->registerPlayer($player, $playerMap, $summary);
                }

                $tournaments = $season['tournaments'] ?? [];
            }

            foreach ($tournaments as $tournamentInfo) {
                $externalTournamentId = (string) ($tournamentInfo['external_id'] ?? '');
                if ($externalTournamentId === '') {
                    continue;
                }

                $url = (string) ($tournamentInfo['url'] ?? "https://www.dartsatlas.com/tournaments/{$externalTournamentId}");
                $tournament = $this->fetchParsed(
                    'tournament',
                    $externalTournamentId,
                    $url,
                    $seasonExternalId,
                    fn(string $html) => $this->parser->parseTournament($html, $url),
                    $summary,
                ) ?? $this->cachedPayload('tournament', $externalTournamentId);

                if ($tournament === null) {
                    $summary['warnings'][] = "Tournament {$externalTournamentId} had no parseable payload.";
                    continue;
                }

                $tournamentName = trim((string) ($tournament['name'] ?? $tournamentInfo['name'] ?? $externalTournamentId));
                $tournamentId = $this->repository->upsertTournament(
                    $this->clubId,
                    $this->localSeasonId,
                    $externalTournamentId,
                    $tournamentName,
                    ['source_url' => $url, 'season_external_id' => $seasonExternalId],
                );
                $summary['tournaments_seen']++;

                foreach ($tournament['players'] ?? [] as $player) {
                    $playerId = $this->registerPlayer($player, $playerMap, $summary);
                    if ($playerId !== null) {
                        $this->repository->addTournamentPlayer($tournamentId, $playerId);
                    }
                }

                foreach ($tournament['matches'] ?? [] as $matchInfo) {
                    $summary['matches_seen']++;
                    $matchExternalId = trim((string) ($matchInfo['external_id'] ?? ''));
                    if ($matchExternalId === '') {
                        continue;
                    }

                    $existingMatchId = $this->repository->externalReference('match', $matchExternalId);
                    $rowStatus = isset($matchInfo['status']) ? (string) $matchInfo['status'] : null;
                    $isDerived = str_starts_with($matchExternalId, 'derived-');
                    $matchUrl = isset($matchInfo['url']) && is_string($matchInfo['url']) && $matchInfo['url'] !== ''
                        ? $matchInfo['url']
                        : "https://www.dartsatlas.com/matches/{$matchExternalId}";

                    // During an 8-second live loop we do not re-poll every historical match.
                    // Active rows are polled continuously; an unknown match page is fetched once
                    // so its players can be mapped. ETag/Last-Modified still applies to every fetch.
                    $pollMatchPage = !$isDerived && (
                        !$targeted
                        || $existingMatchId === null
                        || $rowStatus === 'in_progress'
                    );

                    $matchPayload = null;
                    if ($pollMatchPage) {
                        try {
                            $summary['match_pages_polled']++;
                            $matchPayload = $this->fetchParsed(
                                'match',
                                $matchExternalId,
                                $matchUrl,
                                $externalTournamentId,
                                fn(string $html) => $this->parser->parseMatch($html, $matchUrl),
                                $summary,
                            ) ?? $this->cachedPayload('match', $matchExternalId);
                        } catch (Throwable $error) {
                            $summary['warnings'][] = "Match {$matchExternalId} page failed; tournament snapshot retained.";
                        }
                    } elseif ($existingMatchId === null) {
                        $matchPayload = $this->cachedPayload('match', $matchExternalId);
                    }

                    $matchPlayers = [];
                    foreach (['player_a', 'player_b'] as $key) {
                        if (isset($matchInfo[$key]) && is_array($matchInfo[$key])) {
                            $playerId = $this->registerPlayer($matchInfo[$key], $playerMap, $summary);
                            if ($playerId !== null) {
                                $matchPlayers[] = $playerId;
                                $this->repository->addTournamentPlayer($tournamentId, $playerId);
                            }
                        }
                    }

                    foreach ($matchPayload['players'] ?? [] as $player) {
                        $playerId = $this->registerPlayer($player, $playerMap, $summary);
                        if ($playerId !== null) {
                            $matchPlayers[] = $playerId;
                            $this->repository->addTournamentPlayer($tournamentId, $playerId);
                        }
                    }

                    $matchPlayers = array_values(array_unique($matchPlayers));
                    if (count($matchPlayers) < 2 && $existingMatchId !== null) {
                        $matchId = $existingMatchId;
                    } elseif (count($matchPlayers) < 2) {
                        $summary['warnings'][] = "Match {$matchExternalId} discovered, but two players could not yet be identified.";
                        continue;
                    } else {
                        $matchId = $this->repository->upsertMatch(
                            $tournamentId,
                            $matchExternalId,
                            $matchPlayers[0],
                            $matchPlayers[1],
                            [
                                'source_url' => $isDerived ? $url : $matchUrl,
                                'provider' => 'dartsatlas',
                                'external_id' => $matchExternalId,
                            ],
                        );
                        $summary['matches_mapped']++;
                    }

                    if (isset($matchInfo['status']) || isset($matchInfo['player_a_legs']) || isset($matchInfo['average_a'])) {
                        $this->repository->applyMatchSnapshot($matchId, $matchInfo);
                        $summary['live_states_written']++;
                    }

                    $matchLive = is_array($matchPayload['live'] ?? null) ? $matchPayload['live'] : null;
                    if ($matchLive !== null && $this->hasLiveValues($matchLive)) {
                        $this->repository->applyBroadcastState($matchId, $matchLive, $playerMap);
                        $summary['live_states_written']++;
                    }

                    $pollBroadcast = !$isDerived && (
                        $rowStatus === 'in_progress'
                        || ($matchLive !== null && $this->hasLiveValues($matchLive))
                    );

                    if ($pollBroadcast) {
                        $broadcastUrl = $matchUrl . '/broadcast?mode=dual_cam_stats';
                        try {
                            $summary['broadcasts_polled']++;
                            $broadcast = $this->fetchParsed(
                                'match_broadcast',
                                $matchExternalId,
                                $broadcastUrl,
                                $externalTournamentId,
                                fn(string $html) => $this->parser->parseBroadcast($html, $matchExternalId),
                                $summary,
                            ) ?? $this->cachedPayload('match_broadcast', $matchExternalId);

                            if (is_array($broadcast) && $this->hasLiveValues($broadcast)) {
                                $this->repository->applyBroadcastState($matchId, $broadcast, $playerMap);
                                $summary['live_states_written']++;
                            }
                        } catch (Throwable $error) {
                            $summary['warnings'][] = "Broadcast for {$matchExternalId} unavailable; base match data kept.";
                        }
                    }
                }
            }

            $summary['member_links'] = $this->repository->memberLinkSummary();
            $this->repository->finishJob($jobId, $summary);
            return $summary;
        } catch (Throwable $error) {
            $this->repository->failJob($jobId, $error, $summary);
            throw $error;
        } finally {
            $this->repository->releaseLock($lockName);
        }
    }

    private function registerPlayer(array $player, array &$playerMap, array &$summary): ?int
    {
        $externalId = trim((string) ($player['external_id'] ?? ''));
        $name = trim((string) ($player['name'] ?? ''));
        if ($externalId === '' || $name === '') {
            return null;
        }

        if (!isset($playerMap[$externalId])) {
            $playerMap[$externalId] = $this->repository->upsertPlayer($this->clubId, $externalId, $name);
            $summary['players_seen']++;
        }
        return (int) $playerMap[$externalId];
    }

    private function hasLiveValues(array $payload): bool
    {
        foreach ($payload['players'] ?? [] as $player) {
            if (!is_array($player)) {
                continue;
            }
            foreach (['score', 'legs', 'average', 'first_nine_average', 'darts_thrown', 'score_180', 'highest_checkout'] as $field) {
                if (array_key_exists($field, $player) && $player[$field] !== null && $player[$field] !== '') {
                    return true;
                }
            }
        }
        return false;
    }

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
            $this->repository->upsertResource(
                $resourceType,
                $externalId,
                $url,
                304,
                $response->header('etag') ?? ($cache['etag'] ?? null),
                $response->header('last-modified') ?? ($cache['last_modified'] ?? null),
                $cache['content_hash'] ?? null,
                $parentExternalId,
                $this->cachedPayload($resourceType, $externalId) ?? [],
                false,
            );
            return null;
        }

        $summary['resources_fetched']++;
        $hash = hash('sha256', $response->body);
        $changed = !isset($cache['content_hash']) || $cache['content_hash'] !== $hash;
        $payload = $parse($response->body);
        if (!is_array($payload)) {
            throw new RuntimeException("Parser returned invalid payload for {$resourceType}:{$externalId}");
        }

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

    private function cachedPayload(string $resourceType, string $externalId): ?array
    {
        return $this->repository->resourcePayload($resourceType, $externalId);
    }

    private function mergeByExternalId(array $left, array $right): array
    {
        $merged = [];
        foreach (array_merge($left, $right) as $item) {
            if (!is_array($item)) {
                continue;
            }
            $id = (string) ($item['external_id'] ?? '');
            if ($id === '') {
                continue;
            }
            $merged[$id] = array_merge($merged[$id] ?? [], $item);
        }
        return array_values($merged);
    }
}
