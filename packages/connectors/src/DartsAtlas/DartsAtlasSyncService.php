<?php

declare(strict_types=1);

final class DartsAtlasSyncService
{
    private array $memberIndex = [];
    private bool $memberIndexLoaded = false;

    public function __construct(
        private readonly mysqli $db,
        private readonly string $tablePrefix,
        private readonly int $clubId,
        private readonly string $membersTable,
        private readonly DartsAtlasHttpClient $client,
        private readonly DartsAtlasParser $parser
    ) {
        $this->assertIdentifier($this->tablePrefix, true);
        $this->assertIdentifier($this->membersTable, false);
    }

    public function syncSeason(string $seasonId, bool $deep = false): array
    {
        $this->assertExternalId($seasonId);
        $lock = 'bd_da_season_' . $seasonId;
        if (!$this->acquireLock($lock)) {
            return ['skipped' => true, 'reason' => 'sync_locked', 'season_id' => $seasonId];
        }

        $jobId = $this->startJob('season_sync', 'season', null);
        try {
            $pages = [
                'main' => '/seasons/' . $seasonId,
                'results' => '/seasons/' . $seasonId . '/tournaments/results',
                'calendar' => '/seasons/' . $seasonId . '/tournaments/calendar',
            ];

            $season = null;
            $tournamentUrls = [];
            $fetchedPages = 0;

            foreach ($pages as $pageName => $path) {
                try {
                    $response = $this->client->get($path);
                } catch (Throwable $e) {
                    if ($pageName === 'main') {
                        throw $e;
                    }
                    continue;
                }

                $fetchedPages++;
                $parsed = $this->parser->parseSeason($response->body, $seasonId);
                $this->storeSnapshot(
                    'season_page',
                    $seasonId . ':' . $pageName,
                    $response,
                    'parsed'
                );

                if ($pageName === 'main') {
                    $season = $parsed;
                }
                foreach ($parsed['tournament_urls'] as $url) {
                    $tournamentUrls[$url] = true;
                }
            }

            if ($season === null) {
                throw new RuntimeException('DartsAtlas season could not be parsed.');
            }

            $localSeasonId = $this->upsertSeason($seasonId, (string)$season['name']);
            $tournaments = [];
            foreach (array_keys($tournamentUrls) as $url) {
                if (!preg_match('~^/tournaments/([A-Za-z0-9]+)$~', $url, $match)) {
                    continue;
                }
                try {
                    $tournaments[] = $this->syncTournamentInternal($match[1], $localSeasonId, $deep);
                } catch (Throwable $e) {
                    $tournaments[] = [
                        'external_id' => $match[1],
                        'error' => $e->getMessage(),
                    ];
                }
            }

            $summary = [
                'season_external_id' => $seasonId,
                'season_id' => $localSeasonId,
                'season_name' => $season['name'],
                'season_pages_fetched' => $fetchedPages,
                'tournaments_discovered' => count($tournamentUrls),
                'tournaments' => $tournaments,
            ];
            $this->finishJob($jobId, 'completed', $summary);
            return $summary;
        } catch (Throwable $e) {
            $this->finishJob($jobId, 'failed', null, $e->getMessage());
            throw $e;
        } finally {
            $this->releaseLock($lock);
        }
    }

    public function syncTournament(string $tournamentId, bool $deep = false): array
    {
        $this->assertExternalId($tournamentId);
        return $this->syncTournamentIfStale($tournamentId, 0, $deep);
    }

    public function syncTournamentIfStale(string $tournamentId, int $maxAgeSeconds = 8, bool $deep = false): array
    {
        $this->assertExternalId($tournamentId);
        $maxAgeSeconds = max(0, $maxAgeSeconds);

        if ($maxAgeSeconds > 0 && $this->snapshotIsFresh('tournament', $tournamentId, $maxAgeSeconds)) {
            return ['skipped' => true, 'reason' => 'fresh_cache', 'external_id' => $tournamentId];
        }

        $lock = 'bd_da_tournament_' . $tournamentId;
        if (!$this->acquireLock($lock)) {
            return ['skipped' => true, 'reason' => 'sync_locked', 'external_id' => $tournamentId];
        }

        $jobId = $this->startJob('live_poll', 'tournament', null);
        try {
            if ($maxAgeSeconds > 0 && $this->snapshotIsFresh('tournament', $tournamentId, $maxAgeSeconds)) {
                $summary = ['skipped' => true, 'reason' => 'fresh_cache_after_lock', 'external_id' => $tournamentId];
                $this->finishJob($jobId, 'completed', $summary);
                return $summary;
            }

            $localSeasonId = $this->findTournamentSeasonId($tournamentId);
            $summary = $this->syncTournamentInternal($tournamentId, $localSeasonId, $deep);
            $this->finishJob($jobId, 'completed', $summary);
            return $summary;
        } catch (Throwable $e) {
            $this->finishJob($jobId, 'failed', null, $e->getMessage());
            throw $e;
        } finally {
            $this->releaseLock($lock);
        }
    }

    private function syncTournamentInternal(string $tournamentId, ?int $seasonId, bool $deep): array
    {
        $response = $this->client->get('/tournaments/' . $tournamentId);
        $parsed = $this->parser->parseTournament($response->body, $tournamentId, $response->url);
        $this->storeSnapshot('tournament', $tournamentId, $response, 'parsed');

        $localTournamentId = $this->upsertTournament($parsed, $seasonId);
        $matchCount = 0;
        foreach ($parsed['matches'] as $match) {
            $this->upsertMatch($localTournamentId, $match);
            $matchCount++;
        }

        $subpagesFetched = 0;
        if ($deep) {
            foreach (array_slice($parsed['subpage_urls'], 0, 24) as $subpageUrl) {
                try {
                    $subResponse = $this->client->get($subpageUrl);
                    $subParsed = $this->parser->parseTournament($subResponse->body, $tournamentId, $subResponse->url);
                    $snapshotId = $tournamentId . ':' . substr(hash('sha256', $subpageUrl), 0, 24);
                    $this->storeSnapshot('tournament_page', $snapshotId, $subResponse, 'parsed');
                    foreach ($subParsed['matches'] as $match) {
                        $this->upsertMatch($localTournamentId, $match);
                        $matchCount++;
                    }
                    $subpagesFetched++;
                } catch (Throwable) {
                    // A single group/bracket page must never break the live tournament sync.
                }
            }
        }

        return [
            'external_id' => $tournamentId,
            'tournament_id' => $localTournamentId,
            'name' => $parsed['name'],
            'status' => $parsed['status'],
            'matches_seen' => $matchCount,
            'subpages_fetched' => $subpagesFetched,
            'fetched_at' => date(DATE_ATOM),
        ];
    }

    private function upsertSeason(string $externalId, string $name): int
    {
        $existing = $this->findExternalReference('season', $externalId);
        if ($existing !== null) {
            $stmt = $this->db->prepare('UPDATE `' . $this->t('seasons') . '` SET `name`=? WHERE `id`=?');
            $stmt->bind_param('si', $name, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare('INSERT INTO `' . $this->t('seasons') . '` (`club_id`,`name`,`is_active`) VALUES (?,?,1)');
        $stmt->bind_param('is', $this->clubId, $name);
        $stmt->execute();
        $id = (int)$stmt->insert_id;
        $stmt->close();
        $this->saveExternalReference('season', $externalId, 'season', $id);
        return $id;
    }

    private function upsertTournament(array $parsed, ?int $seasonId): int
    {
        $externalId = (string)$parsed['external_id'];
        $metadata = json_encode([
            'external_id' => $externalId,
            'source_url' => $parsed['source_url'],
            'connector' => 'dartsatlas-live-v1',
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $status = (string)$parsed['status'];
        $name = (string)$parsed['name'];

        $existing = $this->findExternalReference('tournament', $externalId);
        if ($existing !== null) {
            $stmt = $this->db->prepare(
                'UPDATE `' . $this->t('tournaments') . '` SET `season_id`=COALESCE(?,`season_id`), `name`=?, `provider_system`=\'dartsatlas\', `provider_metadata`=?, `status`=? WHERE `id`=?'
            );
            $stmt->bind_param('isssi', $seasonId, $name, $metadata, $status, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare(
            'INSERT INTO `' . $this->t('tournaments') . '` (`club_id`,`season_id`,`name`,`provider_system`,`provider_metadata`,`status`) VALUES (?,?,?,\'dartsatlas\',?,?)'
        );
        $stmt->bind_param('iisss', $this->clubId, $seasonId, $name, $metadata, $status);
        $stmt->execute();
        $id = (int)$stmt->insert_id;
        $stmt->close();
        $this->saveExternalReference('tournament', $externalId, 'tournament', $id);
        return $id;
    }

    private function upsertMatch(int $tournamentId, array $match): int
    {
        $playerA = $this->resolvePlayer($match['player_a']);
        $playerB = $this->resolvePlayer($match['player_b']);
        $winner = null;
        if ($match['status'] === 'completed') {
            $winner = ((int)$match['legs_won_a'] > (int)$match['legs_won_b']) ? $playerA : $playerB;
        }
        $kioskId = $this->resolveKiosk($match['board_number'] ?? null);
        $metadata = json_encode([
            'external_id' => $match['external_id'],
            'raw_text' => $match['raw_text'],
            'provider' => 'dartsatlas',
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $existing = $this->findExternalReference('match', (string)$match['external_id']);
        if ($existing !== null) {
            $current = $this->db->query('SELECT `status` FROM `' . $this->t('matches') . '` WHERE `id`=' . (int)$existing)->fetch_assoc();
            $status = (string)$match['status'];
            if (($current['status'] ?? null) === 'completed' && $status !== 'completed') {
                $status = 'completed';
            }

            $finishedAt = $status === 'completed' ? date('Y-m-d H:i:s') : null;
            $stmt = $this->db->prepare(
                'UPDATE `' . $this->t('matches') . '` SET `kiosk_id`=?, `round_label`=?, `status`=?, `best_of_legs`=?, `legs_to_win`=?, `player_a_id`=?, `player_b_id`=?, `winner_player_id`=?, `legs_won_a`=?, `legs_won_b`=?, `provider_metadata`=?, `live_updated_at`=NOW(), `finished_at`=COALESCE(`finished_at`,?) WHERE `id`=?'
            );
            $round = $match['round_label'];
            $bestOf = (int)$match['best_of_legs'];
            $legsToWin = (int)$match['legs_to_win'];
            $legsA = (int)$match['legs_won_a'];
            $legsB = (int)$match['legs_won_b'];
            $stmt->bind_param('issiiiiiiissi', $kioskId, $round, $status, $bestOf, $legsToWin, $playerA, $playerB, $winner, $legsA, $legsB, $metadata, $finishedAt, $existing);
            $stmt->execute();
            $stmt->close();
            $matchId = $existing;
        } else {
            $status = (string)$match['status'];
            $round = $match['round_label'];
            $bestOf = (int)$match['best_of_legs'];
            $legsToWin = (int)$match['legs_to_win'];
            $legsA = (int)$match['legs_won_a'];
            $legsB = (int)$match['legs_won_b'];
            $finishedAt = $status === 'completed' ? date('Y-m-d H:i:s') : null;
            $stmt = $this->db->prepare(
                'INSERT INTO `' . $this->t('matches') . '` (`tournament_id`,`kiosk_id`,`round_label`,`status`,`best_of_legs`,`legs_to_win`,`player_a_id`,`player_b_id`,`winner_player_id`,`legs_won_a`,`legs_won_b`,`provider_metadata`,`live_updated_at`,`finished_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)'
            );
            $stmt->bind_param('iissiiiiiiiss', $tournamentId, $kioskId, $round, $status, $bestOf, $legsToWin, $playerA, $playerB, $winner, $legsA, $legsB, $metadata, $finishedAt);
            $stmt->execute();
            $matchId = (int)$stmt->insert_id;
            $stmt->close();
            $this->saveExternalReference('match', (string)$match['external_id'], 'match', $matchId);
        }

        $this->upsertMatchAverage($matchId, $playerA, $match['average_a'] ?? null);
        $this->upsertMatchAverage($matchId, $playerB, $match['average_b'] ?? null);
        return $matchId;
    }

    private function resolvePlayer(array $providerPlayer): int
    {
        $name = trim((string)($providerPlayer['name'] ?? ''));
        if ($name === '') {
            throw new RuntimeException('DartsAtlas match contains player without name.');
        }
        $externalId = trim((string)($providerPlayer['external_id'] ?? ''));
        $entityType = 'player';
        if ($externalId === '') {
            $externalId = 'name-v1-' . substr(hash('sha256', $this->normaliseName($name)), 0, 32);
            $entityType = 'player_name';
        }

        $existing = $this->findExternalReference($entityType, $externalId);
        if ($existing !== null) {
            $stmt = $this->db->prepare('UPDATE `' . $this->t('players') . '` SET `display_name`=? WHERE `id`=?');
            $stmt->bind_param('si', $name, $existing);
            $stmt->execute();
            $stmt->close();
            $this->tryLinkMember($existing, $name);
            return $existing;
        }

        $stmt = $this->db->prepare('INSERT INTO `' . $this->t('players') . '` (`club_id`,`display_name`) VALUES (?,?)');
        $stmt->bind_param('is', $this->clubId, $name);
        $stmt->execute();
        $playerId = (int)$stmt->insert_id;
        $stmt->close();
        $this->saveExternalReference($entityType, $externalId, 'player', $playerId);
        $this->tryLinkMember($playerId, $name);
        return $playerId;
    }

    private function tryLinkMember(int $playerId, string $playerName): void
    {
        $row = $this->db->query('SELECT `member_id` FROM `' . $this->t('players') . '` WHERE `id`=' . $playerId)->fetch_assoc();
        if (!empty($row['member_id'])) {
            return;
        }

        $this->loadMemberIndex();
        $key = $this->normaliseName($playerName);
        $candidates = $this->memberIndex[$key] ?? [];
        if (count($candidates) !== 1) {
            return;
        }

        $memberId = (int)$candidates[0]['id'];
        $stmt = $this->db->prepare('SELECT `id` FROM `' . $this->t('players') . '` WHERE `member_id`=? AND `id`<>? LIMIT 1');
        $stmt->bind_param('ii', $memberId, $playerId);
        $stmt->execute();
        $conflict = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ($conflict !== null) {
            return;
        }

        $method = 'exact_name';
        $stmt = $this->db->prepare('UPDATE `' . $this->t('players') . '` SET `member_id`=?, `member_link_method`=?, `member_linked_at`=NOW() WHERE `id`=? AND `member_id` IS NULL');
        $stmt->bind_param('isi', $memberId, $method, $playerId);
        $stmt->execute();
        $stmt->close();
    }

    private function loadMemberIndex(): void
    {
        if ($this->memberIndexLoaded) {
            return;
        }
        $result = $this->db->query('SELECT `id`,`medlemsnummer`,`navn` FROM `' . $this->membersTable . '` ORDER BY `id`');
        while ($row = $result->fetch_assoc()) {
            $key = $this->normaliseName((string)$row['navn']);
            if ($key !== '') {
                $this->memberIndex[$key][] = $row;
            }
        }
        $result->free();
        $this->memberIndexLoaded = true;
    }

    private function resolveKiosk(?int $boardNumber): ?int
    {
        if ($boardNumber === null || $boardNumber < 1) {
            return null;
        }
        $stmt = $this->db->prepare('SELECT `id` FROM `' . $this->t('kiosks') . '` WHERE `club_id`=? AND `board_number`=? AND `is_active`=1 LIMIT 1');
        $stmt->bind_param('ii', $this->clubId, $boardNumber);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row === null ? null : (int)$row['id'];
    }

    private function upsertMatchAverage(int $matchId, int $playerId, mixed $average): void
    {
        if ($average === null || !is_numeric($average)) {
            return;
        }
        $value = (float)$average;
        $stmt = $this->db->prepare(
            'INSERT INTO `' . $this->t('match_player_stats') . '` (`match_id`,`player_id`,`three_dart_average`) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `three_dart_average`=VALUES(`three_dart_average`)'
        );
        $stmt->bind_param('iid', $matchId, $playerId, $value);
        $stmt->execute();
        $stmt->close();
    }

    private function storeSnapshot(string $entityType, string $externalId, DartsAtlasHttpResponse $response, string $parseStatus): void
    {
        $hash = hash('sha256', $response->body);
        $error = null;
        $stmt = $this->db->prepare(
            'INSERT INTO `' . $this->t('provider_snapshots') . '` (`external_system`,`external_entity_type`,`external_id`,`source_url`,`http_status`,`content_sha256`,`payload`,`parse_status`,`parse_error`,`fetched_at`,`parsed_at`) VALUES (\'dartsatlas\',?,?,?,?,?,?,?, ?,NOW(),NOW()) ON DUPLICATE KEY UPDATE `source_url`=VALUES(`source_url`),`http_status`=VALUES(`http_status`),`content_sha256`=VALUES(`content_sha256`),`payload`=VALUES(`payload`),`parse_status`=VALUES(`parse_status`),`parse_error`=VALUES(`parse_error`),`fetched_at`=NOW(),`parsed_at`=NOW()'
        );
        $stmt->bind_param('sssissss', $entityType, $externalId, $response->url, $response->status, $hash, $response->body, $parseStatus, $error);
        $stmt->execute();
        $stmt->close();
    }

    private function snapshotIsFresh(string $entityType, string $externalId, int $maxAgeSeconds): bool
    {
        $stmt = $this->db->prepare(
            'SELECT TIMESTAMPDIFF(SECOND,`fetched_at`,NOW()) AS `age_seconds` FROM `' . $this->t('provider_snapshots') . '` WHERE `external_system`=\'dartsatlas\' AND `external_entity_type`=? AND `external_id`=? LIMIT 1'
        );
        $stmt->bind_param('ss', $entityType, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row !== null && (int)$row['age_seconds'] <= $maxAgeSeconds;
    }

    private function findTournamentSeasonId(string $tournamentExternalId): ?int
    {
        $localId = $this->findExternalReference('tournament', $tournamentExternalId);
        if ($localId === null) {
            return null;
        }
        $row = $this->db->query('SELECT `season_id` FROM `' . $this->t('tournaments') . '` WHERE `id`=' . $localId)->fetch_assoc();
        return empty($row['season_id']) ? null : (int)$row['season_id'];
    }

    private function findExternalReference(string $entityType, string $externalId): ?int
    {
        $stmt = $this->db->prepare(
            'SELECT `internal_id` FROM `' . $this->t('external_references') . '` WHERE `external_system`=\'dartsatlas\' AND `external_entity_type`=? AND `external_id`=? LIMIT 1'
        );
        $stmt->bind_param('ss', $entityType, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row === null ? null : (int)$row['internal_id'];
    }

    private function saveExternalReference(string $externalEntityType, string $externalId, string $internalEntityType, int $internalId): void
    {
        $stmt = $this->db->prepare(
            'INSERT INTO `' . $this->t('external_references') . '` (`external_system`,`external_entity_type`,`external_id`,`internal_entity_type`,`internal_id`,`sync_state`,`last_synced_at`) VALUES (\'dartsatlas\',?,?,?,?,\'synced\',NOW()) ON DUPLICATE KEY UPDATE `internal_entity_type`=VALUES(`internal_entity_type`),`internal_id`=VALUES(`internal_id`),`sync_state`=\'synced\',`last_synced_at`=NOW()'
        );
        $stmt->bind_param('sssi', $externalEntityType, $externalId, $internalEntityType, $internalId);
        $stmt->execute();
        $stmt->close();
    }

    private function startJob(string $jobType, ?string $scopeType, ?int $scopeId): int
    {
        $status = 'running';
        $stmt = $this->db->prepare(
            'INSERT INTO `' . $this->t('connector_sync_jobs') . '` (`external_system`,`job_type`,`scope_entity_type`,`scope_entity_id`,`status`,`started_at`) VALUES (\'dartsatlas\',?,?,?,?,NOW())'
        );
        $stmt->bind_param('ssis', $jobType, $scopeType, $scopeId, $status);
        $stmt->execute();
        $id = (int)$stmt->insert_id;
        $stmt->close();
        return $id;
    }

    private function finishJob(int $jobId, string $status, ?array $summary, ?string $error = null): void
    {
        $summaryJson = $summary === null ? null : json_encode($summary, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $stmt = $this->db->prepare(
            'UPDATE `' . $this->t('connector_sync_jobs') . '` SET `status`=?,`summary_json`=?,`error_message`=?,`finished_at`=NOW() WHERE `id`=?'
        );
        $stmt->bind_param('sssi', $status, $summaryJson, $error, $jobId);
        $stmt->execute();
        $stmt->close();
    }

    private function acquireLock(string $name): bool
    {
        $stmt = $this->db->prepare('SELECT GET_LOCK(?,0) AS `locked`');
        $stmt->bind_param('s', $name);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return (int)($row['locked'] ?? 0) === 1;
    }

    private function releaseLock(string $name): void
    {
        $stmt = $this->db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->bind_param('s', $name);
        $stmt->execute();
        $stmt->close();
    }

    private function normaliseName(string $name): string
    {
        $name = mb_strtolower(trim((string)preg_replace('/\s+/u', ' ', $name)));
        $ascii = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name);
        if ($ascii !== false) {
            $name = $ascii;
        }
        return trim((string)preg_replace('/[^a-z0-9]+/', ' ', $name));
    }

    private function t(string $name): string
    {
        return $this->tablePrefix . $name;
    }

    private function assertIdentifier(string $value, bool $allowEmpty): void
    {
        if (($value === '' && $allowEmpty) || preg_match('/^[A-Za-z0-9_]+$/', $value)) {
            return;
        }
        throw new InvalidArgumentException('Unsafe SQL identifier in connector configuration.');
    }

    private function assertExternalId(string $value): void
    {
        if (!preg_match('/^[A-Za-z0-9_-]{3,190}$/', $value)) {
            throw new InvalidArgumentException('Invalid DartsAtlas external id.');
        }
    }
}
