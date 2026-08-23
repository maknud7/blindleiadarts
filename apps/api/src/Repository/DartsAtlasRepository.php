<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli;
use Throwable;

final class DartsAtlasRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private string $membersTable;

    public function __construct(Database $database, string $membersTable = 'medlemmer')
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $this->safeIdentifier($database->tablePrefix(), true);
        $this->membersTable = $this->safeIdentifier($membersTable, false);
    }

    public function acquireLock(string $scope, int $timeoutSeconds = 0): bool
    {
        $lockName = 'blindleia:dartsatlas:' . substr(hash('sha256', $scope), 0, 40);
        $statement = $this->connection->prepare('SELECT GET_LOCK(?, ?) AS acquired');
        $statement->bind_param('si', $lockName, $timeoutSeconds);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();

        return (int) ($row['acquired'] ?? 0) === 1;
    }

    public function releaseLock(string $scope): void
    {
        $lockName = 'blindleia:dartsatlas:' . substr(hash('sha256', $scope), 0, 40);
        $statement = $this->connection->prepare('SELECT RELEASE_LOCK(?)');
        $statement->bind_param('s', $lockName);
        $statement->execute();
        $statement->close();
    }

    public function startJob(string $jobType, ?string $scopeType = null, ?int $scopeId = null): int
    {
        $table = $this->table('connector_sync_jobs');
        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}` (external_system, job_type, scope_entity_type, scope_entity_id, status, started_at)
             VALUES ('dartsatlas', ?, ?, ?, 'running', NOW())"
        );
        $statement->bind_param('ssi', $jobType, $scopeType, $scopeId);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $id;
    }

    /** @param array<string, mixed> $summary */
    public function finishJob(int $jobId, array $summary): void
    {
        $table = $this->table('connector_sync_jobs');
        $json = $this->json($summary);
        $statement = $this->connection->prepare(
            "UPDATE `{$table}` SET status = 'completed', summary_json = ?, finished_at = NOW() WHERE id = ?"
        );
        $statement->bind_param('si', $json, $jobId);
        $statement->execute();
        $statement->close();
    }

    /** @param array<string, mixed> $summary */
    public function failJob(int $jobId, Throwable $error, array $summary = []): void
    {
        $table = $this->table('connector_sync_jobs');
        $json = $this->json($summary);
        $message = mb_substr($error->getMessage(), 0, 4000);
        $statement = $this->connection->prepare(
            "UPDATE `{$table}` SET status = 'failed', summary_json = ?, error_message = ?, finished_at = NOW() WHERE id = ?"
        );
        $statement->bind_param('ssi', $json, $message, $jobId);
        $statement->execute();
        $statement->close();
    }

    /** @return array<string, mixed> */
    public function resourceCache(string $resourceType, string $externalId): array
    {
        $table = $this->table('connector_resources');
        $statement = $this->connection->prepare(
            "SELECT etag, last_modified, content_hash
             FROM `{$table}`
             WHERE external_system = 'dartsatlas' AND resource_type = ? AND external_id = ?
             LIMIT 1"
        );
        $statement->bind_param('ss', $resourceType, $externalId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();

        return $row;
    }

    /** @return array<string, mixed>|null */
    public function resourcePayload(string $resourceType, string $externalId): ?array
    {
        $table = $this->table('connector_resources');
        $statement = $this->connection->prepare(
            "SELECT payload_json
             FROM `{$table}`
             WHERE external_system = 'dartsatlas' AND resource_type = ? AND external_id = ?
             LIMIT 1"
        );
        $statement->bind_param('ss', $resourceType, $externalId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();

        if (!$row || !is_string($row['payload_json'] ?? null) || $row['payload_json'] === '') {
            return null;
        }

        $decoded = json_decode($row['payload_json'], true);
        return is_array($decoded) ? $decoded : null;
    }

    /** @param array<string, mixed> $payload */
    public function upsertResource(
        string $resourceType,
        string $externalId,
        string $url,
        int $httpStatus,
        ?string $etag,
        ?string $lastModified,
        ?string $contentHash,
        ?string $parentExternalId,
        array $payload,
        bool $changed,
    ): void {
        $table = $this->table('connector_resources');
        $payloadJson = $this->json($payload);
        $changedSql = $changed ? 'NOW()' : 'last_changed_at';
        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}`
                (external_system, resource_type, external_id, parent_external_id, source_url, etag, last_modified,
                 content_hash, last_http_status, payload_json, first_seen_at, last_seen_at, last_changed_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                parent_external_id = VALUES(parent_external_id),
                source_url = VALUES(source_url),
                etag = VALUES(etag),
                last_modified = VALUES(last_modified),
                content_hash = COALESCE(VALUES(content_hash), content_hash),
                last_http_status = VALUES(last_http_status),
                payload_json = VALUES(payload_json),
                last_seen_at = NOW(),
                last_changed_at = {$changedSql}"
        );
        $statement->bind_param(
            'sssssssiss',
            $resourceType,
            $externalId,
            $parentExternalId,
            $url,
            $etag,
            $lastModified,
            $contentHash,
            $httpStatus,
            $payloadJson,
        );
        $statement->execute();
        $statement->close();
    }

    public function upsertPlayer(int $clubId, string $externalId, string $displayName): int
    {
        $existing = $this->externalReference('player', $externalId);
        $players = $this->table('players');

        if ($existing !== null) {
            $statement = $this->connection->prepare("UPDATE `{$players}` SET display_name = ? WHERE id = ?");
            $statement->bind_param('si', $displayName, $existing);
            $statement->execute();
            $statement->close();
            $this->tryLinkMember($existing, $displayName);
            return $existing;
        }

        $memberId = $this->findExactMemberId($displayName);
        if ($memberId !== null && !$this->memberIsAvailable($memberId)) {
            $memberId = null;
        }

        $linkSource = $memberId !== null ? 'name_exact' : null;
        $statement = $this->connection->prepare(
            "INSERT INTO `{$players}`
                (club_id, member_id, member_link_source, member_linked_at, display_name)
             VALUES (?, ?, ?, IF(? IS NULL, NULL, NOW()), ?)"
        );
        $statement->bind_param('iisss', $clubId, $memberId, $linkSource, $linkSource, $displayName);
        $statement->execute();
        $playerId = (int) $statement->insert_id;
        $statement->close();

        $this->insertExternalReference('player', $externalId, 'player', $playerId);
        return $playerId;
    }

    /** @param array<string, mixed> $metadata */
    public function upsertTournament(
        int $clubId,
        ?int $seasonId,
        string $externalId,
        string $name,
        array $metadata = [],
        string $status = 'ready',
    ): int {
        $existing = $this->externalReference('tournament', $externalId);
        $tournaments = $this->table('tournaments');
        $metadataJson = $this->json($metadata);
        $status = in_array($status, ['draft', 'ready', 'in_progress', 'completed', 'archived'], true) ? $status : 'ready';

        if ($existing !== null) {
            $statement = $this->connection->prepare(
                "UPDATE `{$tournaments}`
                 SET name = ?, provider_system = 'dartsatlas', provider_metadata = ?,
                     status = CASE WHEN status IN ('completed', 'archived') THEN status ELSE ? END,
                     start_at = CASE WHEN ? = 'in_progress' AND start_at IS NULL THEN NOW() ELSE start_at END
                 WHERE id = ?"
            );
            $statement->bind_param('ssssi', $name, $metadataJson, $status, $status, $existing);
            $statement->execute();
            $statement->close();
            return $existing;
        }

        $statement = $this->connection->prepare(
            "INSERT INTO `{$tournaments}`
                (club_id, season_id, name, provider_system, provider_metadata, status, start_at)
             VALUES (?, ?, ?, 'dartsatlas', ?, ?, IF(? = 'in_progress', NOW(), NULL))"
        );
        $statement->bind_param('iissss', $clubId, $seasonId, $name, $metadataJson, $status, $status);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        $this->insertExternalReference('tournament', $externalId, 'tournament', $id);
        return $id;
    }

    public function addTournamentPlayer(int $tournamentId, int $playerId, string $status = 'checked_in'): void
    {
        $table = $this->table('tournament_players');
        $status = in_array($status, ['registered', 'checked_in', 'withdrawn', 'eliminated'], true) ? $status : 'checked_in';
        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}` (tournament_id, player_id, status)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
                status = IF(status = 'withdrawn', status, VALUES(status)),
                updated_at = NOW()"
        );
        $statement->bind_param('iis', $tournamentId, $playerId, $status);
        $statement->execute();
        $statement->close();
    }

    /** @param array<string, mixed> $metadata */
    public function upsertMatch(
        int $tournamentId,
        string $externalId,
        int $playerAId,
        int $playerBId,
        array $metadata = [],
    ): int {
        $existing = $this->externalReference('match', $externalId);
        $matches = $this->table('matches');
        $metadataJson = $this->json($metadata);

        if ($existing !== null) {
            $statement = $this->connection->prepare(
                "UPDATE `{$matches}`
                 SET player_a_id = ?, player_b_id = ?, provider_metadata = ?
                 WHERE id = ?"
            );
            $statement->bind_param('iisi', $playerAId, $playerBId, $metadataJson, $existing);
            $statement->execute();
            $statement->close();
            return $existing;
        }

        $statement = $this->connection->prepare(
            "INSERT INTO `{$matches}`
                (tournament_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id, provider_metadata)
             VALUES (?, 'pending', 3, 2, ?, ?, ?)"
        );
        $statement->bind_param('iiis', $tournamentId, $playerAId, $playerBId, $metadataJson);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        $this->insertExternalReference('match', $externalId, 'match', $id);
        return $id;
    }

    /** @param array<string, mixed> $snapshot */
    public function applyMatchSnapshot(int $matchId, int $clubId, array $snapshot): void
    {
        $matches = $this->table('matches');
        $statement = $this->connection->prepare(
            "SELECT status, player_a_id, player_b_id FROM `{$matches}` WHERE id = ? LIMIT 1"
        );
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $current = $statement->get_result()->fetch_assoc();
        $statement->close();

        if (!$current) {
            return;
        }

        $incomingStatus = (string) ($snapshot['status'] ?? '');
        $status = in_array($incomingStatus, ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'], true)
            ? $incomingStatus
            : (string) $current['status'];

        if ((string) $current['status'] === 'completed' && $status !== 'completed') {
            $status = 'completed';
        }

        $roundLabel = isset($snapshot['round_label']) ? trim((string) $snapshot['round_label']) : null;
        $bestOf = max(1, (int) ($snapshot['best_of_legs'] ?? 3));
        $legsToWin = max(1, (int) ($snapshot['legs_to_win'] ?? (intdiv($bestOf, 2) + 1)));
        $boardNumber = isset($snapshot['board_number']) && is_numeric($snapshot['board_number'])
            ? (int) $snapshot['board_number']
            : null;
        $kioskId = $this->kioskIdForBoard($clubId, $boardNumber);
        $playerALegs = $this->nullableInt($snapshot['player_a_legs'] ?? null);
        $playerBLegs = $this->nullableInt($snapshot['player_b_legs'] ?? null);
        $winnerId = null;

        if ($status === 'completed' && $playerALegs !== null && $playerBLegs !== null && $playerALegs !== $playerBLegs) {
            $winnerId = $playerALegs > $playerBLegs ? (int) $current['player_a_id'] : (int) $current['player_b_id'];
        }

        $metadata = $this->json($snapshot);
        $statement = $this->connection->prepare(
            "UPDATE `{$matches}` SET
                kiosk_id = COALESCE(?, kiosk_id),
                round_label = COALESCE(?, round_label),
                status = ?,
                best_of_legs = ?,
                legs_to_win = ?,
                winner_player_id = CASE WHEN ? IS NULL THEN winner_player_id ELSE ? END,
                provider_metadata = ?,
                starts_at = CASE WHEN ? = 'in_progress' AND starts_at IS NULL THEN NOW() ELSE starts_at END,
                finished_at = CASE WHEN ? = 'completed' AND finished_at IS NULL THEN NOW() ELSE finished_at END
             WHERE id = ?"
        );
        $statement->bind_param(
            'issiiiisssi',
            $kioskId,
            $roundLabel,
            $status,
            $bestOf,
            $legsToWin,
            $winnerId,
            $winnerId,
            $metadata,
            $status,
            $status,
            $matchId,
        );
        $statement->execute();
        $statement->close();

        $this->upsertLiveMatchState($matchId, null, null, $playerALegs, $playerBLegs, null, $status, $snapshot);

        if (isset($snapshot['average_a']) && is_numeric($snapshot['average_a'])) {
            $this->upsertMatchStatistics($matchId, (int) $current['player_a_id'], [
                'legs_won' => $playerALegs,
                'average' => (float) $snapshot['average_a'],
            ]);
        }

        if (isset($snapshot['average_b']) && is_numeric($snapshot['average_b'])) {
            $this->upsertMatchStatistics($matchId, (int) $current['player_b_id'], [
                'legs_won' => $playerBLegs,
                'average' => (float) $snapshot['average_b'],
            ]);
        }
    }

    /** @param array<string, mixed> $payload @param array<string, int> $externalPlayerMap */
    public function applyBroadcastState(int $matchId, array $payload, array $externalPlayerMap): void
    {
        $matches = $this->table('matches');
        $statement = $this->connection->prepare(
            "SELECT player_a_id, player_b_id, status FROM `{$matches}` WHERE id = ? LIMIT 1"
        );
        $statement->bind_param('i', $matchId);
        $statement->execute();
        $match = $statement->get_result()->fetch_assoc();
        $statement->close();

        if (!$match) {
            return;
        }

        $byInternalId = [];
        foreach ($payload['players'] ?? [] as $player) {
            if (!is_array($player)) {
                continue;
            }

            $externalId = trim((string) ($player['external_id'] ?? ''));
            $internalId = $externalId !== '' ? ($externalPlayerMap[$externalId] ?? null) : null;
            if ($internalId === null) {
                continue;
            }

            $byInternalId[(int) $internalId] = $player;
            $this->upsertMatchStatistics($matchId, (int) $internalId, $player);
        }

        $a = $byInternalId[(int) $match['player_a_id']] ?? [];
        $b = $byInternalId[(int) $match['player_b_id']] ?? [];
        $scoreA = $this->nullableInt($a['score'] ?? null);
        $scoreB = $this->nullableInt($b['score'] ?? null);
        $legsA = $this->nullableInt($a['legs'] ?? null);
        $legsB = $this->nullableInt($b['legs'] ?? null);
        $providerStatus = null;

        if ((string) $match['status'] !== 'completed' && ($scoreA !== null || $scoreB !== null || $legsA !== null || $legsB !== null)) {
            $providerStatus = 'in_progress';
        } elseif ((string) $match['status'] === 'completed') {
            $providerStatus = 'completed';
        }

        $this->upsertLiveMatchState($matchId, $scoreA, $scoreB, $legsA, $legsB, null, $providerStatus, $payload);
    }

    /** @param array<string, mixed> $stats */
    public function upsertMatchStatistics(int $matchId, int $playerId, array $stats): void
    {
        $table = $this->table('match_statistics');
        $legsWon = $this->nullableInt($stats['legs_won'] ?? $stats['legs'] ?? null);
        $average = $this->nullableFloat($stats['average'] ?? null);
        $firstNine = $this->nullableFloat($stats['first_nine_average'] ?? null);
        $dartsThrown = $this->nullableInt($stats['darts_thrown'] ?? null);
        $checkoutHits = $this->nullableInt($stats['checkout_hits'] ?? null);
        $checkoutAttempts = $this->nullableInt($stats['checkout_attempts'] ?? null);
        $highestCheckout = $this->nullableInt($stats['highest_checkout'] ?? null);
        $score100 = $this->nullableInt($stats['score_100_plus'] ?? null);
        $score140 = $this->nullableInt($stats['score_140_plus'] ?? null);
        $score180 = $this->nullableInt($stats['score_180'] ?? null);
        $metadata = $this->json($stats);

        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_id, legs_won, average, first_nine_average, darts_thrown,
                 checkout_hits, checkout_attempts, highest_checkout, score_100_plus, score_140_plus, score_180, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                legs_won = COALESCE(VALUES(legs_won), legs_won),
                average = COALESCE(VALUES(average), average),
                first_nine_average = COALESCE(VALUES(first_nine_average), first_nine_average),
                darts_thrown = COALESCE(VALUES(darts_thrown), darts_thrown),
                checkout_hits = COALESCE(VALUES(checkout_hits), checkout_hits),
                checkout_attempts = COALESCE(VALUES(checkout_attempts), checkout_attempts),
                highest_checkout = COALESCE(VALUES(highest_checkout), highest_checkout),
                score_100_plus = COALESCE(VALUES(score_100_plus), score_100_plus),
                score_140_plus = COALESCE(VALUES(score_140_plus), score_140_plus),
                score_180 = COALESCE(VALUES(score_180), score_180),
                provider_metadata = VALUES(provider_metadata)"
        );
        $statement->bind_param(
            'iiiddi' . 'iiiiiis',
            $matchId,
            $playerId,
            $legsWon,
            $average,
            $firstNine,
            $dartsThrown,
            $checkoutHits,
            $checkoutAttempts,
            $highestCheckout,
            $score100,
            $score140,
            $score180,
            $metadata,
        );
        $statement->execute();
        $statement->close();
    }

    /** @return array<string, int> */
    public function memberLinkSummary(int $clubId): array
    {
        $players = $this->table('players');
        $statement = $this->connection->prepare(
            "SELECT COUNT(*) AS total,
                    SUM(member_id IS NOT NULL) AS linked,
                    SUM(member_id IS NULL) AS unmatched
             FROM `{$players}`
             WHERE club_id = ?"
        );
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();

        return [
            'total' => (int) ($row['total'] ?? 0),
            'linked' => (int) ($row['linked'] ?? 0),
            'unmatched' => (int) ($row['unmatched'] ?? 0),
        ];
    }

    /** @return array<string, mixed> */
    public function providerFeedStatus(?int $tournamentId = null): array
    {
        $resources = $this->table('connector_resources');
        $sql = "SELECT MAX(last_seen_at) AS last_seen_at FROM `{$resources}` WHERE external_system = 'dartsatlas'";
        $statement = null;

        if ($tournamentId !== null) {
            $references = $this->table('external_references');
            $sql .= " AND (parent_external_id IN (
                        SELECT external_id FROM `{$references}`
                        WHERE external_system = 'dartsatlas'
                          AND external_entity_type = 'tournament'
                          AND internal_entity_type = 'tournament'
                          AND internal_id = ?
                    ) OR (resource_type = 'tournament' AND external_id IN (
                        SELECT external_id FROM `{$references}`
                        WHERE external_system = 'dartsatlas'
                          AND external_entity_type = 'tournament'
                          AND internal_entity_type = 'tournament'
                          AND internal_id = ?
                    )))";
            $statement = $this->connection->prepare($sql);
            $statement->bind_param('ii', $tournamentId, $tournamentId);
        } else {
            $statement = $this->connection->prepare($sql);
        }

        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();
        $lastSeen = $row['last_seen_at'] ?? null;
        $age = $lastSeen !== null ? max(0, time() - strtotime((string) $lastSeen)) : null;
        $status = $age === null ? 'idle' : ($age <= 30 ? 'live' : ($age <= 120 ? 'delayed' : 'stale'));

        return [
            'provider' => 'dartsatlas',
            'status' => $status,
            'last_seen_at' => $lastSeen,
            'age_seconds' => $age,
        ];
    }

    public function externalReference(string $entityType, string $externalId): ?int
    {
        $table = $this->table('external_references');
        $statement = $this->connection->prepare(
            "SELECT internal_id FROM `{$table}`
             WHERE external_system = 'dartsatlas'
               AND external_entity_type = ?
               AND external_id = ?
             LIMIT 1"
        );
        $statement->bind_param('ss', $entityType, $externalId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();

        return $row ? (int) $row['internal_id'] : null;
    }

    private function tryLinkMember(int $playerId, string $displayName): void
    {
        $players = $this->table('players');
        $statement = $this->connection->prepare("SELECT member_id FROM `{$players}` WHERE id = ? LIMIT 1");
        $statement->bind_param('i', $playerId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();

        if ($row && $row['member_id'] !== null) {
            return;
        }

        $memberId = $this->findExactMemberId($displayName);
        if ($memberId === null || !$this->memberIsAvailable($memberId, $playerId)) {
            return;
        }

        $source = 'name_exact';
        $statement = $this->connection->prepare(
            "UPDATE `{$players}`
             SET member_id = ?, member_link_source = ?, member_linked_at = NOW()
             WHERE id = ? AND member_id IS NULL"
        );
        $statement->bind_param('isi', $memberId, $source, $playerId);
        $statement->execute();
        $statement->close();
    }

    private function findExactMemberId(string $displayName): ?int
    {
        $target = $this->normaliseName($displayName);
        if ($target === '') {
            return null;
        }

        $result = $this->connection->query("SELECT id, navn FROM `{$this->membersTable}` ORDER BY id");
        $matches = [];

        while ($row = $result->fetch_assoc()) {
            if ($this->normaliseName((string) ($row['navn'] ?? '')) === $target) {
                $matches[] = (int) $row['id'];
            }
        }
        $result->free();

        return count($matches) === 1 ? $matches[0] : null;
    }

    private function memberIsAvailable(int $memberId, ?int $currentPlayerId = null): bool
    {
        $players = $this->table('players');
        $sql = "SELECT id FROM `{$players}` WHERE member_id = ?";

        if ($currentPlayerId !== null) {
            $sql .= ' AND id <> ?';
            $statement = $this->connection->prepare($sql . ' LIMIT 1');
            $statement->bind_param('ii', $memberId, $currentPlayerId);
        } else {
            $statement = $this->connection->prepare($sql . ' LIMIT 1');
            $statement->bind_param('i', $memberId);
        }

        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();

        return !$row;
    }

    private function kioskIdForBoard(int $clubId, ?int $boardNumber): ?int
    {
        if ($boardNumber === null || $boardNumber <= 0) {
            return null;
        }

        $kiosks = $this->table('kiosks');
        $statement = $this->connection->prepare(
            "SELECT id FROM `{$kiosks}`
             WHERE club_id = ? AND board_number = ? AND is_active = 1
             LIMIT 1"
        );
        $statement->bind_param('ii', $clubId, $boardNumber);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        $statement->close();

        return $row ? (int) $row['id'] : null;
    }

    /** @param array<string, mixed> $metadata */
    private function upsertLiveMatchState(
        int $matchId,
        ?int $scoreA,
        ?int $scoreB,
        ?int $legsA,
        ?int $legsB,
        ?int $throwingPlayerId,
        ?string $providerStatus,
        array $metadata,
    ): void {
        $table = $this->table('live_match_states');
        $metadataJson = $this->json($metadata);
        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_a_score, player_b_score, player_a_legs, player_b_legs,
                 throwing_player_id, provider_status, provider_updated_at, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                player_a_score = COALESCE(VALUES(player_a_score), player_a_score),
                player_b_score = COALESCE(VALUES(player_b_score), player_b_score),
                player_a_legs = COALESCE(VALUES(player_a_legs), player_a_legs),
                player_b_legs = COALESCE(VALUES(player_b_legs), player_b_legs),
                throwing_player_id = COALESCE(VALUES(throwing_player_id), throwing_player_id),
                provider_status = COALESCE(VALUES(provider_status), provider_status),
                provider_updated_at = NOW(),
                provider_metadata = VALUES(provider_metadata)"
        );
        $statement->bind_param(
            'iiiiiiss',
            $matchId,
            $scoreA,
            $scoreB,
            $legsA,
            $legsB,
            $throwingPlayerId,
            $providerStatus,
            $metadataJson,
        );
        $statement->execute();
        $statement->close();
    }

    private function insertExternalReference(string $externalType, string $externalId, string $internalType, int $internalId): void
    {
        $table = $this->table('external_references');
        $statement = $this->connection->prepare(
            "INSERT INTO `{$table}`
                (external_system, external_entity_type, external_id, internal_entity_type, internal_id, sync_state, last_synced_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, 'synced', NOW())
             ON DUPLICATE KEY UPDATE
                internal_entity_type = VALUES(internal_entity_type),
                internal_id = VALUES(internal_id),
                sync_state = 'synced',
                last_synced_at = NOW()"
        );
        $statement->bind_param('sssi', $externalType, $externalId, $internalType, $internalId);
        $statement->execute();
        $statement->close();
    }

    private function table(string $name): string
    {
        return $this->tablePrefix . $this->safeIdentifier($name, false);
    }

    private function safeIdentifier(string $identifier, bool $allowEmpty): string
    {
        if ($identifier === '' && $allowEmpty) {
            return '';
        }

        if (!preg_match('/^[A-Za-z0-9_]+$/', $identifier)) {
            throw new InvalidArgumentException('Unsafe SQL identifier.');
        }

        return $identifier;
    }

    private function normaliseName(string $name): string
    {
        $name = mb_strtolower(trim($name), 'UTF-8');
        $name = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $name) ?? $name;
        return trim((string) preg_replace('/\s+/u', ' ', $name));
    }

    private function nullableInt(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        return is_numeric($value) ? (int) $value : null;
    }

    private function nullableFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }
        $normalized = is_string($value) ? str_replace(',', '.', $value) : $value;
        return is_numeric($normalized) ? (float) $normalized : null;
    }

    /** @param array<string, mixed> $payload */
    private function json(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
