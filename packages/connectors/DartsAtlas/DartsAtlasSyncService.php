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

                $resultsUrl = $seasonUrl . '/tournaments/results';
                $results = $this->fetchParsed(
                    'season_results',
                    $seasonExternalId,
                    $resultsUrl,
                    $seasonExternalId,
                    fn(string $html) => $this->parser->parseSeason($html, $seasonUrl),
                    $summary,
                ) ?? $this->cachedPayload('season_results', $seasonExternalId);

                if (is_array($results)) {
                    $season['players'] = $this->mergeByExternalId($season['players'] ?? [], $results['players'] ?? []);
                    $season['tournaments'] = $this->mergeByExternalId($season['tournaments'] ?? [], $results['tournaments'] ?? []);
                }

                foreach ($season['players'] ?? [] as $player) {
                    $name = trim((string) ($player['name'] ?? ''));
                    $externalId = (string) ($player['external_id'] ?? '');
                    if ($name === '' || $externalId === '') {
                        continue;
                    }
                    $playerMap[$externalId] = $this->repository->upsertPlayer($this->clubId, $externalId, $name);
                    $summary['players_seen']++;
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
                    $externalId = (string) ($player['external_id'] ?? '');
                    $name = trim((string) ($player['name'] ?? ''));
                    if ($externalId === '' || $name === '') {
                        continue;
                    }
                    $playerMap[$externalId] ??= $this->repository->upsertPlayer($this->clubId, $externalId, $name);
                    $this->repository->addTournamentPlayer($tournamentId, $playerMap[$externalId]);
                    $summary['players_seen']++;
                }

                foreach ($tournament['matches'] ?? [] as $matchInfo) {
                    $summary['matches_seen']++;
                    $matchExternalId = (string) ($matchInfo['external_id'] ?? '');
                    if ($matchExternalId === '') {
                        continue;
                    }

                    $matchUrl = "https://www.dartsatlas.com/matches/{$matchExternalId}";
                    $match = $this->fetchParsed(
                        'match',
                        $matchExternalId,
                        $matchUrl,
                        $externalTournamentId,
                        fn(string $html) => $this->parser->parseMatch($html, $matchUrl),
                        $summary,
                    ) ?? $this->cachedPayload('match', $matchExternalId);

                    if ($match === null) {
                        continue;
                    }

                    $matchPlayers = [];
                    foreach ($match['players'] ?? [] as $player) {
                        $externalId = (string) ($player['external_id'] ?? '');
                        $name = trim((string) ($player['name'] ?? ''));
                        if ($externalId === '' || $name === '') {
                            continue;
                        }
                        $playerMap[$externalId] ??= $this->repository->upsertPlayer($this->clubId, $externalId, $name);
                        $matchPlayers[] = $playerMap[$externalId];
                        $this->repository->addTournamentPlayer($tournamentId, $playerMap[$externalId]);
                    }

                    $matchPlayers = array_values(array_unique($matchPlayers));
                    if (count($matchPlayers) < 2) {
                        $summary['warnings'][] = "Match {$matchExternalId} discovered, but two players could not yet be identified.";
                        continue;
                    }

                    $this->repository->upsertMatch(
                        $tournamentId,
                        $matchExternalId,
                        $matchPlayers[0],
                        $matchPlayers[1],
                        ['source_url' => $matchUrl],
                    );
                    $summary['matches_mapped']++;

                    $broadcastUrl = $matchUrl . '/broadcast?mode=dual_cam_stats';
                    $this->fetchParsed(
                        'match_broadcast',
                        $matchExternalId,
                        $broadcastUrl,
                        $externalTournamentId,
                        fn(string $html) => $this->parser->parseBroadcast($html, $matchExternalId),
                        $summary,
                    );
                }
            }

            $summary['member_links'] = $this->repository->memberLinkSummary();
            $this->repository->finishJob($jobId, $summary);
            return $summary;
        } catch (Throwable $error) {
            $this->repository->failJob($jobId, $error, $summary);
            throw $error;
        }
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
