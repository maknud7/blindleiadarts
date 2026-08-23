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
        if ($memberId === null) {
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

    private function json(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
