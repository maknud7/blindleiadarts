<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli;
use Throwable;

final class DartsAtlasRepository
{
    private mysqli $db;
    private string $prefix;
    private string $membersTable;

    public function __construct(Database $database, string $membersTable = 'medlemmer')
    {
        $this->db = $database->connection();
        $this->prefix = $this->identifier($database->tablePrefix(), true);
        $this->membersTable = $this->identifier($membersTable);
    }

    public function acquireLock(string $scope): bool
    {
        $name = 'blindleia:dartsatlas:' . substr(hash('sha256', $scope), 0, 40);
        $timeout = 0;
        $stmt = $this->db->prepare('SELECT GET_LOCK(?, ?) AS acquired');
        $stmt->bind_param('si', $name, $timeout);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return (int) ($row['acquired'] ?? 0) === 1;
    }

    public function releaseLock(string $scope): void
    {
        $name = 'blindleia:dartsatlas:' . substr(hash('sha256', $scope), 0, 40);
        $stmt = $this->db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->bind_param('s', $name);
        $stmt->execute();
        $stmt->close();
    }

    public function startJob(string $jobType, ?string $scopeType, ?int $scopeId): int
    {
        $table = $this->table('connector_sync_jobs');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (external_system, job_type, scope_entity_type, scope_entity_id, status, started_at)
             VALUES ('dartsatlas', ?, ?, ?, 'running', NOW())"
        );
        $stmt->bind_param('ssi', $jobType, $scopeType, $scopeId);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    /** @param array<string, mixed> $summary */
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

    /** @param array<string, mixed> $summary */
    public function failJob(int $jobId, Throwable $error, array $summary): void
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

    /** @return array<string, mixed> */
    public function resourceCache(string $type, string $externalId): array
    {
        $table = $this->table('connector_resources');
        $stmt = $this->db->prepare(
            "SELECT etag, last_modified, content_hash FROM `{$table}`
             WHERE external_system='dartsatlas' AND resource_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $type, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return $row;
    }

    /** @return array<string, mixed>|null */
    public function resourcePayload(string $type, string $externalId): ?array
    {
        $table = $this->table('connector_resources');
        $stmt = $this->db->prepare(
            "SELECT payload_json FROM `{$table}`
             WHERE external_system='dartsatlas' AND resource_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $type, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        if (!$row || !is_string($row['payload_json'] ?? null) || $row['payload_json'] === '') {
            return null;
        }
        $decoded = json_decode($row['payload_json'], true);
        return is_array($decoded) ? $decoded : null;
    }

    /** @param array<string, mixed> $payload */
    public function upsertResource(
        string $type,
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
             (external_system, resource_type, external_id, parent_external_id, source_url, etag,
              last_modified, content_hash, last_http_status, payload_json, first_seen_at, last_seen_at, last_changed_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               parent_external_id=VALUES(parent_external_id), source_url=VALUES(source_url),
               etag=VALUES(etag), last_modified=VALUES(last_modified),
               content_hash=COALESCE(VALUES(content_hash), content_hash),
               last_http_status=VALUES(last_http_status), payload_json=VALUES(payload_json),
               last_seen_at=NOW(), last_changed_at={$changedSql}"
        );
        $stmt->bind_param(
            'sssssssis',
            $type,
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
        $players = $this->table('players');

        if ($existing !== null) {
            $stmt = $this->db->prepare("UPDATE `{$players}` SET display_name=? WHERE id=?");
            $stmt->bind_param('si', $displayName, $existing);
            $stmt->execute();
            $stmt->close();
            $this->tryLinkMember($existing, $displayName);
            return $existing;
        }

        $memberId = $this->findExactMemberId($displayName);
        if ($memberId !== null && !$this->memberAvailable($memberId)) {
            $memberId = null;
        }
        $source = $memberId !== null ? 'name_exact' : null;

        $stmt = $this->db->prepare(
            "INSERT INTO `{$players}`
             (club_id, member_id, member_link_source, member_linked_at, display_name)
             VALUES (?, ?, ?, IF(? IS NULL, NULL, NOW()), ?)"
        );
        $stmt->bind_param('iisss', $clubId, $memberId, $source, $source, $displayName);
        $stmt->execute();
        $playerId = (int) $stmt->insert_id;
        $stmt->close();

        $this->saveExternalReference('player', $externalId, 'player', $playerId);
        return $playerId;
    }

    /** @param array<string, mixed> $metadata */
    public function upsertTournament(
        int $clubId,
        ?int $seasonId,
        string $externalId,
        string $name,
        array $metadata,
        string $status,
    ): int {
        $existing = $this->externalReference('tournament', $externalId);
        $table = $this->table('tournaments');
        $json = $this->json($metadata);
        $status = in_array($status, ['draft', 'ready', 'in_progress', 'completed', 'archived'], true) ? $status : 'ready';

        if ($existing !== null) {
            $stmt = $this->db->prepare(
                "UPDATE `{$table}` SET name=?, provider_system='dartsatlas', provider_metadata=?,
                 status=CASE WHEN status IN ('completed','archived') THEN status ELSE ? END,
                 start_at=CASE WHEN ?='in_progress' AND start_at IS NULL THEN NOW() ELSE start_at END
                 WHERE id=?"
            );
            $stmt->bind_param('ssssi', $name, $json, $status, $status, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (club_id, season_id, name, provider_system, provider_metadata, status, start_at)
             VALUES (?, ?, ?, 'dartsatlas', ?, ?, IF(?='in_progress', NOW(), NULL))"
        );
        $stmt->bind_param('iissss', $clubId, $seasonId, $name, $json, $status, $status);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        $this->saveExternalReference('tournament', $externalId, 'tournament', $id);
        return $id;
    }

    public function addTournamentPlayer(int $tournamentId, int $playerId, string $status = 'checked_in'): void
    {
        $table = $this->table('tournament_players');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}` (tournament_id, player_id, status) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE status=IF(status='withdrawn', status, VALUES(status)), updated_at=NOW()"
        );
        $stmt->bind_param('iis', $tournamentId, $playerId, $status);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<string, mixed> $metadata */
    public function upsertMatch(int $tournamentId, string $externalId, int $playerAId, int $playerBId, array $metadata): int
    {
        $existing = $this->externalReference('match', $externalId);
        $table = $this->table('matches');
        $json = $this->json($metadata);

        if ($existing !== null) {
            $stmt = $this->db->prepare(
                "UPDATE `{$table}` SET player_a_id=?, player_b_id=?, provider_metadata=? WHERE id=?"
            );
            $stmt->bind_param('iisi', $playerAId, $playerBId, $json, $existing);
            $stmt->execute();
            $stmt->close();
            return $existing;
        }

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (tournament_id, status, best_of_legs, legs_to_win, player_a_id, player_b_id, provider_metadata)
             VALUES (?, 'pending', 3, 2, ?, ?, ?)"
        );
        $stmt->bind_param('iiis', $tournamentId, $playerAId, $playerBId, $json);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        $this->saveExternalReference('match', $externalId, 'match', $id);
        return $id;
    }

    /** @param array<string, mixed> $snapshot */
    public function applyMatchSnapshot(int $matchId, int $clubId, array $snapshot): void
    {
        $match = $this->matchBasics($matchId);
        if ($match === null) {
            return;
        }

        $status = (string) ($snapshot['status'] ?? $match['status']);
        if (!in_array($status, ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'], true)) {
            $status = (string) $match['status'];
        }
        if ((string) $match['status'] === 'completed') {
            $status = 'completed';
        }

        $legsA = $this->toInt($snapshot['player_a_legs'] ?? null);
        $legsB = $this->toInt($snapshot['player_b_legs'] ?? null);
        $bestOf = max(1, (int) ($snapshot['best_of_legs'] ?? 3));
        $legsToWin = max(1, (int) ($snapshot['legs_to_win'] ?? (intdiv($bestOf, 2) + 1)));
        $board = $this->toInt($snapshot['board_number'] ?? null);
        $kioskId = $this->kioskId($clubId, $board);
        $round = isset($snapshot['round_label']) ? trim((string) $snapshot['round_label']) : null;
        $winner = null;

        if ($status === 'completed' && $legsA !== null && $legsB !== null && $legsA !== $legsB) {
            $winner = $legsA > $legsB ? (int) $match['player_a_id'] : (int) $match['player_b_id'];
        }

        $table = $this->table('matches');
        $metadata = $this->json($snapshot);
        $stmt = $this->db->prepare(
            "UPDATE `{$table}` SET kiosk_id=COALESCE(?, kiosk_id), round_label=COALESCE(?, round_label),
             status=?, best_of_legs=?, legs_to_win=?,
             winner_player_id=CASE WHEN ? IS NULL THEN winner_player_id ELSE ? END,
             provider_metadata=?,
             starts_at=CASE WHEN ?='in_progress' AND starts_at IS NULL THEN NOW() ELSE starts_at END,
             finished_at=CASE WHEN ?='completed' AND finished_at IS NULL THEN NOW() ELSE finished_at END
             WHERE id=?"
        );
        $stmt->bind_param(
            'issiiiisssi',
            $kioskId,
            $round,
            $status,
            $bestOf,
            $legsToWin,
            $winner,
            $winner,
            $metadata,
            $status,
            $status,
            $matchId,
        );
        $stmt->execute();
        $stmt->close();

        $this->saveLiveState($matchId, null, null, $legsA, $legsB, null, $status, $snapshot);

        if (isset($snapshot['average_a']) || $legsA !== null) {
            $this->saveStats($matchId, (int) $match['player_a_id'], [
                'average' => $snapshot['average_a'] ?? null,
                'legs_won' => $legsA,
            ]);
        }
        if (isset($snapshot['average_b']) || $legsB !== null) {
            $this->saveStats($matchId, (int) $match['player_b_id'], [
                'average' => $snapshot['average_b'] ?? null,
                'legs_won' => $legsB,
            ]);
        }
    }

    /** @param array<string, mixed> $payload @param array<string, int> $playerMap */
    public function applyBroadcastState(int $matchId, array $payload, array $playerMap): void
    {
        $match = $this->matchBasics($matchId);
        if ($match === null) {
            return;
        }

        $mapped = [];
        foreach ($payload['players'] ?? [] as $player) {
            if (!is_array($player)) {
                continue;
            }
            $externalId = trim((string) ($player['external_id'] ?? ''));
            if ($externalId === '' || !isset($playerMap[$externalId])) {
                continue;
            }
            $internalId = (int) $playerMap[$externalId];
            $mapped[$internalId] = $player;
            $this->saveStats($matchId, $internalId, $player);
        }

        $a = $mapped[(int) $match['player_a_id']] ?? [];
        $b = $mapped[(int) $match['player_b_id']] ?? [];
        $scoreA = $this->toInt($a['score'] ?? null);
        $scoreB = $this->toInt($b['score'] ?? null);
        $legsA = $this->toInt($a['legs'] ?? null);
        $legsB = $this->toInt($b['legs'] ?? null);
        $status = (string) $match['status'] === 'completed' ? 'completed' : 'in_progress';

        if ($scoreA === null && $scoreB === null && $legsA === null && $legsB === null) {
            $status = null;
        }
        $this->saveLiveState($matchId, $scoreA, $scoreB, $legsA, $legsB, null, $status, $payload);
    }

    /** @return array<string, int> */
    public function memberLinkSummary(int $clubId): array
    {
        $table = $this->table('players');
        $stmt = $this->db->prepare(
            "SELECT COUNT(*) total, SUM(member_id IS NOT NULL) linked, SUM(member_id IS NULL) unmatched
             FROM `{$table}` WHERE club_id=?"
        );
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return [
            'total' => (int) ($row['total'] ?? 0),
            'linked' => (int) ($row['linked'] ?? 0),
            'unmatched' => (int) ($row['unmatched'] ?? 0),
        ];
    }

    public function externalReference(string $type, string $externalId): ?int
    {
        $table = $this->table('external_references');
        $stmt = $this->db->prepare(
            "SELECT internal_id FROM `{$table}`
             WHERE external_system='dartsatlas' AND external_entity_type=? AND external_id=? LIMIT 1"
        );
        $stmt->bind_param('ss', $type, $externalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row ? (int) $row['internal_id'] : null;
    }

    /** @return array<string, mixed>|null */
    private function matchBasics(int $matchId): ?array
    {
        $table = $this->table('matches');
        $stmt = $this->db->prepare(
            "SELECT id, status, player_a_id, player_b_id FROM `{$table}` WHERE id=? LIMIT 1"
        );
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string, mixed> $stats */
    private function saveStats(int $matchId, int $playerId, array $stats): void
    {
        $table = $this->table('match_statistics');
        $legs = $this->toInt($stats['legs_won'] ?? $stats['legs'] ?? null);
        $average = $this->toFloat($stats['average'] ?? null);
        $firstNine = $this->toFloat($stats['first_nine_average'] ?? null);
        $darts = $this->toInt($stats['darts_thrown'] ?? null);
        $checkoutHits = $this->toInt($stats['checkout_hits'] ?? null);
        $checkoutAttempts = $this->toInt($stats['checkout_attempts'] ?? null);
        $highestCheckout = $this->toInt($stats['highest_checkout'] ?? null);
        $score100 = $this->toInt($stats['score_100_plus'] ?? null);
        $score140 = $this->toInt($stats['score_140_plus'] ?? null);
        $score180 = $this->toInt($stats['score_180'] ?? null);
        $metadata = $this->json($stats);

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (match_id, player_id, legs_won, average, first_nine_average, darts_thrown,
              checkout_hits, checkout_attempts, highest_checkout, score_100_plus, score_140_plus, score_180, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
              legs_won=COALESCE(VALUES(legs_won),legs_won), average=COALESCE(VALUES(average),average),
              first_nine_average=COALESCE(VALUES(first_nine_average),first_nine_average),
              darts_thrown=COALESCE(VALUES(darts_thrown),darts_thrown),
              checkout_hits=COALESCE(VALUES(checkout_hits),checkout_hits),
              checkout_attempts=COALESCE(VALUES(checkout_attempts),checkout_attempts),
              highest_checkout=COALESCE(VALUES(highest_checkout),highest_checkout),
              score_100_plus=COALESCE(VALUES(score_100_plus),score_100_plus),
              score_140_plus=COALESCE(VALUES(score_140_plus),score_140_plus),
              score_180=COALESCE(VALUES(score_180),score_180), provider_metadata=VALUES(provider_metadata)"
        );
        $stmt->bind_param(
            'iiiddi' . 'iiiiiis',
            $matchId,
            $playerId,
            $legs,
            $average,
            $firstNine,
            $darts,
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

    /** @param array<string, mixed> $metadata */
    private function saveLiveState(
        int $matchId,
        ?int $scoreA,
        ?int $scoreB,
        ?int $legsA,
        ?int $legsB,
        ?int $throwingPlayerId,
        ?string $status,
        array $metadata,
    ): void {
        $table = $this->table('live_match_states');
        $json = $this->json($metadata);
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (match_id, player_a_score, player_b_score, player_a_legs, player_b_legs,
              throwing_player_id, provider_status, provider_updated_at, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)
             ON DUPLICATE KEY UPDATE
              player_a_score=COALESCE(VALUES(player_a_score),player_a_score),
              player_b_score=COALESCE(VALUES(player_b_score),player_b_score),
              player_a_legs=COALESCE(VALUES(player_a_legs),player_a_legs),
              player_b_legs=COALESCE(VALUES(player_b_legs),player_b_legs),
              throwing_player_id=COALESCE(VALUES(throwing_player_id),throwing_player_id),
              provider_status=COALESCE(VALUES(provider_status),provider_status),
              provider_updated_at=NOW(), provider_metadata=VALUES(provider_metadata)"
        );
        $stmt->bind_param('iiiiiiss', $matchId, $scoreA, $scoreB, $legsA, $legsB, $throwingPlayerId, $status, $json);
        $stmt->execute();
        $stmt->close();
    }

    private function tryLinkMember(int $playerId, string $name): void
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

        $memberId = $this->findExactMemberId($name);
        if ($memberId === null || !$this->memberAvailable($memberId, $playerId)) {
            return;
        }
        $source = 'name_exact';
        $stmt = $this->db->prepare(
            "UPDATE `{$players}` SET member_id=?, member_link_source=?, member_linked_at=NOW()
             WHERE id=? AND member_id IS NULL"
        );
        $stmt->bind_param('isi', $memberId, $source, $playerId);
        $stmt->execute();
        $stmt->close();
    }

    private function findExactMemberId(string $name): ?int
    {
        $target = $this->normaliseName($name);
        if ($target === '') {
            return null;
        }

        $result = $this->db->query("SELECT id, navn FROM `{$this->membersTable}` ORDER BY id");
        $matches = [];
        while ($row = $result->fetch_assoc()) {
            if ($this->normaliseName((string) ($row['navn'] ?? '')) === $target) {
                $matches[] = (int) $row['id'];
            }
        }
        $result->free();
        return count($matches) === 1 ? $matches[0] : null;
    }

    private function memberAvailable(int $memberId, ?int $excludePlayerId = null): bool
    {
        $players = $this->table('players');
        if ($excludePlayerId === null) {
            $stmt = $this->db->prepare("SELECT id FROM `{$players}` WHERE member_id=? LIMIT 1");
            $stmt->bind_param('i', $memberId);
        } else {
            $stmt = $this->db->prepare("SELECT id FROM `{$players}` WHERE member_id=? AND id<>? LIMIT 1");
            $stmt->bind_param('ii', $memberId, $excludePlayerId);
        }
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return !$row;
    }

    private function kioskId(int $clubId, ?int $boardNumber): ?int
    {
        if ($boardNumber === null || $boardNumber <= 0) {
            return null;
        }
        $table = $this->table('kiosks');
        $stmt = $this->db->prepare(
            "SELECT id FROM `{$table}` WHERE club_id=? AND board_number=? AND is_active=1 LIMIT 1"
        );
        $stmt->bind_param('ii', $clubId, $boardNumber);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        return $row ? (int) $row['id'] : null;
    }

    private function saveExternalReference(string $externalType, string $externalId, string $internalType, int $internalId): void
    {
        $table = $this->table('external_references');
        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
             (external_system, external_entity_type, external_id, internal_entity_type, internal_id, sync_state, last_synced_at)
             VALUES ('dartsatlas', ?, ?, ?, ?, 'synced', NOW())
             ON DUPLICATE KEY UPDATE internal_entity_type=VALUES(internal_entity_type),
              internal_id=VALUES(internal_id), sync_state='synced', last_synced_at=NOW()"
        );
        $stmt->bind_param('sssi', $externalType, $externalId, $internalType, $internalId);
        $stmt->execute();
        $stmt->close();
    }

    private function table(string $name): string
    {
        return $this->prefix . $this->identifier($name);
    }

    private function identifier(string $value, bool $allowEmpty = false): string
    {
        if ($allowEmpty && $value === '') {
            return '';
        }
        if (!preg_match('/^[A-Za-z0-9_]+$/', $value)) {
            throw new InvalidArgumentException('Unsafe SQL identifier.');
        }
        return $value;
    }

    private function normaliseName(string $name): string
    {
        $name = mb_strtolower(trim($name), 'UTF-8');
        $name = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $name) ?? $name;
        return trim((string) preg_replace('/\s+/u', ' ', $name));
    }

    private function toInt(mixed $value): ?int
    {
        return $value === null || $value === '' || !is_numeric($value) ? null : (int) $value;
    }

    private function toFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }
        $value = is_string($value) ? str_replace(',', '.', $value) : $value;
        return is_numeric($value) ? (float) $value : null;
    }

    /** @param array<string, mixed> $payload */
    private function json(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
