<?php

declare(strict_types=1);

final class DartsAtlasRepository
{
    private readonly string $prefix;
    private readonly string $membersTable;

    public function __construct(
        private readonly mysqli $db,
        string $tablePrefix,
        string $membersTable = 'medlemmer',
    ) {
        $this->prefix = $this->safeIdentifier($tablePrefix, true);
        $this->membersTable = $this->safeIdentifier($membersTable, false);
    }

    public function acquireLock(string $name): bool
    {
        $lockName = 'blindleia:dartsatlas:' . substr(hash('sha256', $name), 0, 32);
        $stmt = $this->db->prepare('SELECT GET_LOCK(?, 0) AS acquired');
        $stmt->bind_param('s', $lockName);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return (int) ($row['acquired'] ?? 0) === 1;
    }

    public function releaseLock(string $name): void
    {
        $lockName = 'blindleia:dartsatlas:' . substr(hash('sha256', $name), 0, 32);
        $stmt = $this->db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->bind_param('s', $lockName);
        $stmt->execute();
        $stmt->close();
    }

    public function startJob(string $jobType, ?string $scopeType = null, ?int $scopeId = null): int
    {
        $table = $this->table('connector_sync_jobs');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}` (external_system, job_type, scope_entity_type, scope_entity_id, status, started_at)
             VALUES ('dartsatlas', ?, ?, ?, 'running', NOW())"
        );
        $stmt->bind_param('ssi', $jobType, $scopeType, $scopeId);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    public function finishJob(int $jobId, array $summary): void
    {
        $table = $this->table('connector_sync_jobs');
        $json = $this->json($summary);
        $stmt = $this->db->prepare(
            "UPDATE `{$table}` SET status='completed', summary_json=?, finished_at=NOW() WHERE id=?"
        );
        $stmt->bind_param('si', $json, $jobId);
        $stmt->execute();
        $stmt->close();
    }

    public function failJob(int $jobId, Throwable $error, array $summary = []): void
    {
        $table = $this->table('connector_sync_jobs');
        $json = $this->json($summary);
        $message = mb_substr($error->getMessage(), 0, 4000);
        $stmt = $this->db->prepare(
            "UPDATE `{$table}` SET status='failed', summary_json=?, error_message=?, finished_at=NOW() WHERE id=?"
        );
        $stmt->bind_param('ssi', $json, $message, $jobId);
        $stmt->execute();
        $stmt->close();
    }

    public function resourceCache(string $resourceType, string $externalId): array
    {
        $table = $this->table('connector_resources');
        $stmt = $this->db->prepare(
            "SELECT etag, last_modified, content_hash FROM `{$table}`
             WHERE external_system='dartsatlas' AND resource_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $resourceType, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return $row;
    }

    public function resourcePayload(string $resourceType, string $externalId): ?array
    {
        $table = $this->table('connector_resources');
        $stmt = $this->db->prepare(
            "SELECT payload_json FROM `{$table}`
             WHERE external_system='dartsatlas' AND resource_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $resourceType, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        if (!$row || !is_string($row['payload_json']) || $row['payload_json'] === '') {
            return null;
        }

        $decoded = json_decode($row['payload_json'], true, flags: JSON_THROW_ON_ERROR);
        return is_array($decoded) ? $decoded : null;
    }

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
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (external_system, resource_type, external_id, parent_external_id, source_url, etag, last_modified,
                 content_hash, last_http_status, payload_json, first_seen_at, last_seen_at, last_changed_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                parent_external_id=VALUES(parent_external_id), source_url=VALUES(source_url), etag=VALUES(etag),
                last_modified=VALUES(last_modified), content_hash=COALESCE(VALUES(content_hash), content_hash),
                last_http_status=VALUES(last_http_status), payload_json=VALUES(payload_json), last_seen_at=NOW(),
                last_changed_at={$changedSql}"
        );
        $stmt->bind_param(
            'sssssssis',
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
        $stmt->execute();
        $stmt->close();
    }

    public function upsertPlayer(int $clubId, string $externalId, string $displayName): int
    {
        $existing = $this->externalReference('player', $externalId);
        if ($existing !== null) {
            $players = $this->table('players');
            $stmt = $this->db->prepare("UPDATE `{$players}` SET display_name=? WHERE id=?");
            $stmt->bind_param('si', $displayName, $existing);
            $stmt->execute();
            $stmt->close();
            $this->tryLinkMember($existing, $displayName);
            return $existing;
        }

        $memberId = $this->findExactMemberId($displayName);
        if ($memberId !== null && !$this->memberIsAvailable($memberId)) {
            $memberId = null;
        }
        $linkSource = $memberId !== null ? 'name_exact' : null;
        $players = $this->table('players');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$players}` (club_id, member_id, member_link_source, member_linked_at, display_name)
             VALUES (?, ?, ?, IF(? IS NULL, NULL, NOW()), ?)"
        );
        $stmt->bind_param('iisss', $clubId, $memberId, $linkSource, $linkSource, $displayName);
        $stmt->execute();
        $playerId = (int) $stmt->insert_id;
        $stmt->close();

        $this->insertExternalReference('player', $externalId, 'player', $playerId);
        return $playerId;
    }

    public function upsertTournament(
        int $clubId,
        ?int $seasonId,
        string $externalId,
        string $name,
        array $metadata = [],
    ): int {
        $existing = $this->externalReference('tournament', $externalId);
        $tournaments = $this->table('tournaments');
        $json = $this->json($metadata);

        if ($existing !== null) {
            $stmt = $this->db->prepare(
                "UPDATE `{$tournaments}` SET name=?, provider_system='dartsatlas', provider_metadata=? WHERE id=?"
            );
            $stmt->bind_param('ssi', $name, $json, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare(
            "INSERT INTO `{$tournaments}` (club_id, season_id, name, provider_system, provider_metadata, status)
             VALUES (?, ?, ?, 'dartsatlas', ?, 'ready')"
        );
        $stmt->bind_param('iiss', $clubId, $seasonId, $name, $json);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        $this->insertExternalReference('tournament', $externalId, 'tournament', $id);
        return $id;
    }

    public function addTournamentPlayer(int $tournamentId, int $playerId): void
    {
        $table = $this->table('tournament_players');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}` (tournament_id, player_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE updated_at=NOW()"
        );
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $stmt->close();
    }

    public function upsertMatch(
        int $tournamentId,
        string $externalId,
        int $playerAId,
        int $playerBId,
        array $metadata = [],
    ): int {
        $existing = $this->externalReference('match', $externalId);
        $matches = $this->table('matches');
        $json = $this->json($metadata);

        if ($existing !== null) {
            $stmt = $this->db->prepare(
                "UPDATE `{$matches}` SET player_a_id=?, player_b_id=?, provider_metadata=? WHERE id=?"
            );
            $stmt->bind_param('iisi', $playerAId, $playerBId, $json, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare(
            "INSERT INTO `{$matches}`
                (tournament_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id, provider_metadata)
             VALUES (?, 'assigned', 3, 2, ?, ?, ?)"
        );
        $stmt->bind_param('iiis', $tournamentId, $playerAId, $playerBId, $json);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        $this->insertExternalReference('match', $externalId, 'match', $id);
        return $id;
    }

    public function applyMatchSnapshot(int $matchId, array $snapshot): void
    {
        $matches = $this->table('matches');
        $current = $this->db->query(
            "SELECT status, player_a_id, player_b_id FROM `{$matches}` WHERE id=" . (int) $matchId . ' LIMIT 1'
        )->fetch_assoc();
        if (!$current) {
            return;
        }

        $incomingStatus = (string) ($snapshot['status'] ?? '');
        $status = in_array($incomingStatus, ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'], true)
            ? $incomingStatus
            : (string) $current['status'];
        if ($current['status'] === 'completed' && $status !== 'completed') {
            $status = 'completed';
        }

        $roundLabel = isset($snapshot['round_label']) ? trim((string) $snapshot['round_label']) : null;
        $bestOf = max(1, (int) ($snapshot['best_of_legs'] ?? 3));
        $legsToWin = max(1, (int) ($snapshot['legs_to_win'] ?? (intdiv($bestOf, 2) + 1)));
        $boardNumber = isset($snapshot['board_number']) && is_numeric($snapshot['board_number'])
            ? (int) $snapshot['board_number']
            : null;
        $kioskId = $this->kioskIdForBoard($boardNumber);
        $playerALegs = isset($snapshot['player_a_legs']) ? (int) $snapshot['player_a_legs'] : null;
        $playerBLegs = isset($snapshot['player_b_legs']) ? (int) $snapshot['player_b_legs'] : null;
        $winnerId = null;
        if ($status === 'completed' && $playerALegs !== null && $playerBLegs !== null && $playerALegs !== $playerBLegs) {
            $winnerId = $playerALegs > $playerBLegs ? (int) $current['player_a_id'] : (int) $current['player_b_id'];
        }
        $metadata = $this->json($snapshot);

        $stmt = $this->db->prepare(
            "UPDATE `{$matches}` SET
                kiosk_id=COALESCE(?, kiosk_id),
                round_label=COALESCE(?, round_label),
                status=?, best_of_legs=?, legs_to_win=?,
                winner_player_id=COALESCE(?, winner_player_id),
                provider_metadata=?,
                starts_at=CASE WHEN ?='in_progress' AND starts_at IS NULL THEN NOW() ELSE starts_at END,
                finished_at=CASE WHEN ?='completed' AND finished_at IS NULL THEN NOW() ELSE finished_at END
             WHERE id=?"
        );
        $stmt->bind_param(
            'issiiisssi',
            $kioskId,
            $roundLabel,
            $status,
            $bestOf,
            $legsToWin,
            $winnerId,
            $metadata,
            $status,
            $status,
            $matchId,
        );
        $stmt->execute();
        $stmt->close();

        $this->upsertLiveMatchState(
            $matchId,
            null,
            null,
            $playerALegs,
            $playerBLegs,
            null,
            null,
            $status,
            $snapshot,
        );

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

    public function applyBroadcastState(int $matchId, array $payload, array $externalPlayerMap): void
    {
        $matches = $this->table('matches');
        $match = $this->db->query(
            "SELECT player_a_id, player_b_id FROM `{$matches}` WHERE id=" . (int) $matchId . ' LIMIT 1'
        )->fetch_assoc();
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
                $name = trim((string) ($player['name'] ?? ''));
                foreach ($externalPlayerMap as $mapped) {
                    if (is_array($mapped) && isset($mapped['id'], $mapped['name']) && $this->normaliseName((string) $mapped['name']) === $this->normaliseName($name)) {
                        $internalId = (int) $mapped['id'];
                        break;
                    }
                }
            }
            if ($internalId !== null) {
                $byInternalId[(int) $internalId] = $player;
                $this->upsertMatchStatistics($matchId, (int) $internalId, $player);
            }
        }

        $a = $byInternalId[(int) $match['player_a_id']] ?? [];
        $b = $byInternalId[(int) $match['player_b_id']] ?? [];
        $scoreA = isset($a['score']) && is_numeric($a['score']) ? (int) $a['score'] : null;
        $scoreB = isset($b['score']) && is_numeric($b['score']) ? (int) $b['score'] : null;
        $legsA = isset($a['legs']) && is_numeric($a['legs']) ? (int) $a['legs'] : null;
        $legsB = isset($b['legs']) && is_numeric($b['legs']) ? (int) $b['legs'] : null;

        $providerStatus = null;
        if ($legsA !== null || $legsB !== null || $scoreA !== null || $scoreB !== null) {
            $providerStatus = 'in_progress';
        }

        $this->upsertLiveMatchState(
            $matchId,
            $scoreA,
            $scoreB,
            $legsA,
            $legsB,
            null,
            null,
            $providerStatus,
            $payload,
        );
    }

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

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_id, legs_won, average, first_nine_average, darts_thrown,
                 checkout_hits, checkout_attempts, highest_checkout, score_100_plus, score_140_plus, score_180, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                legs_won=COALESCE(VALUES(legs_won), legs_won),
                average=COALESCE(VALUES(average), average),
                first_nine_average=COALESCE(VALUES(first_nine_average), first_nine_average),
                darts_thrown=COALESCE(VALUES(darts_thrown), darts_thrown),
                checkout_hits=COALESCE(VALUES(checkout_hits), checkout_hits),
                checkout_attempts=COALESCE(VALUES(checkout_attempts), checkout_attempts),
                highest_checkout=GREATEST(COALESCE(highest_checkout,0), COALESCE(VALUES(highest_checkout),0)),
                score_100_plus=COALESCE(VALUES(score_100_plus), score_100_plus),
                score_140_plus=COALESCE(VALUES(score_140_plus), score_140_plus),
                score_180=COALESCE(VALUES(score_180), score_180),
                provider_metadata=VALUES(provider_metadata), updated_at=NOW()"
        );
        $stmt->bind_param(
            'iiiddiiiiiiis',
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
        $stmt->execute();
        $stmt->close();
    }

    public function upsertLiveMatchState(
        int $matchId,
        ?int $playerAScore,
        ?int $playerBScore,
        ?int $playerALegs,
        ?int $playerBLegs,
        ?int $currentLeg,
        ?int $throwingPlayerId,
        ?string $providerStatus,
        array $metadata,
    ): void {
        $table = $this->table('live_match_states');
        $json = $this->json($metadata);
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_a_score, player_b_score, player_a_legs, player_b_legs,
                 current_leg, throwing_player_id, provider_status, provider_updated_at, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                player_a_score=COALESCE(VALUES(player_a_score), player_a_score),
                player_b_score=COALESCE(VALUES(player_b_score), player_b_score),
                player_a_legs=COALESCE(VALUES(player_a_legs), player_a_legs),
                player_b_legs=COALESCE(VALUES(player_b_legs), player_b_legs),
                current_leg=COALESCE(VALUES(current_leg), current_leg),
                throwing_player_id=COALESCE(VALUES(throwing_player_id), throwing_player_id),
                provider_status=COALESCE(VALUES(provider_status), provider_status),
                provider_updated_at=NOW(), provider_metadata=VALUES(provider_metadata), updated_at=NOW()"
        );
        $stmt->bind_param(
            'iiiiiiiss',
            $matchId,
            $playerAScore,
            $playerBScore,
            $playerALegs,
            $playerBLegs,
            $currentLeg,
            $throwingPlayerId,
            $providerStatus,
            $json,
        );
        $stmt->execute();
        $stmt->close();
    }

    public function externalReference(string $entityType, string $externalId): ?int
    {
        $table = $this->table('external_references');
        $stmt = $this->db->prepare(
            "SELECT internal_id FROM `{$table}`
             WHERE external_system='dartsatlas' AND external_entity_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $entityType, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row ? (int) $row['internal_id'] : null;
    }

    public function memberLinkSummary(): array
    {
        $players = $this->table('players');
        $result = $this->db->query(
            "SELECT COUNT(*) AS total,
                    SUM(member_id IS NOT NULL) AS linked,
                    SUM(member_id IS NULL) AS unmatched
             FROM `{$players}`"
        );
        $row = $result->fetch_assoc() ?: [];
        $result->free();
        return [
            'total' => (int) ($row['total'] ?? 0),
            'linked' => (int) ($row['linked'] ?? 0),
            'unmatched' => (int) ($row['unmatched'] ?? 0),
        ];
    }

    private function tryLinkMember(int $playerId, string $displayName): void
    {
        $players = $this->table('players');
        $stmt = $this->db->prepare("SELECT member_id FROM `{$players}` WHERE id=? LIMIT 1");
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ($row && $row['member_id'] !== null) {
            return;
        }

        $memberId = $this->findExactMemberId($displayName);
        if ($memberId === null || !$this->memberIsAvailable($memberId, $playerId)) {
            return;
        }

        $source = 'name_exact';
        $stmt = $this->db->prepare(
            "UPDATE `{$players}` SET member_id=?, member_link_source=?, member_linked_at=NOW() WHERE id=? AND member_id IS NULL"
        );
        $stmt->bind_param('isi', $memberId, $source, $playerId);
        $stmt->execute();
        $stmt->close();
    }

    private function memberIsAvailable(int $memberId, ?int $exceptPlayerId = null): bool
    {
        $players = $this->table('players');
        if ($exceptPlayerId === null) {
            $stmt = $this->db->prepare("SELECT id FROM `{$players}` WHERE member_id=? LIMIT 1");
            $stmt->bind_param('i', $memberId);
        } else {
            $stmt = $this->db->prepare("SELECT id FROM `{$players}` WHERE member_id=? AND id<>? LIMIT 1");
            $stmt->bind_param('ii', $memberId, $exceptPlayerId);
        }
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return !$exists;
    }

    private function findExactMemberId(string $displayName): ?int
    {
        $normalisedTarget = $this->normaliseName($displayName);
        if ($normalisedTarget === '') {
            return null;
        }

        $result = $this->db->query("SELECT id, navn FROM `{$this->membersTable}` ORDER BY id");
        $matches = [];
        while ($row = $result->fetch_assoc()) {
            if ($this->normaliseName((string) $row['navn']) === $normalisedTarget) {
                $matches[] = (int) $row['id'];
            }
        }
        $result->free();

        return count($matches) === 1 ? $matches[0] : null;
    }

    private function kioskIdForBoard(?int $boardNumber): ?int
    {
        if ($boardNumber === null || $boardNumber < 1) {
            return null;
        }
        $table = $this->table('kiosks');
        $stmt = $this->db->prepare("SELECT id FROM `{$table}` WHERE board_number=? AND is_active=1 ORDER BY id LIMIT 1");
        $stmt->bind_param('i', $boardNumber);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row ? (int) $row['id'] : null;
    }

    private function insertExternalReference(string $externalType, string $externalId, string $internalType, int $internalId): void
    {
        $table = $this->table('external_references');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (external_system, external_entity_type, external_id, internal_entity_type, internal_id, sync_state, last_synced_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, 'synced', NOW())
             ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type), internal_id=VALUES(internal_id),
                 sync_state='synced', last_synced_at=NOW()"
        );
        $stmt->bind_param('sssi', $externalType, $externalId, $internalType, $internalId);
        $stmt->execute();
        $stmt->close();
    }

    private function table(string $name): string
    {
        return $this->prefix . $this->safeIdentifier($name, false);
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
        return $value !== null && is_numeric($value) ? (int) $value : null;
    }

    private function nullableFloat(mixed $value): ?float
    {
        return $value !== null && is_numeric($value) ? (float) $value : null;
    }

    private function json(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
