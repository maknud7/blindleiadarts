<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;
use Throwable;

final class ScoliaRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed> */
    public function getClubSettings(int $clubId, bool $includeSecret = false): array
    {
        $sql = sprintf('SELECT * FROM `%1$sscolia_club_settings` WHERE club_id=? LIMIT 1', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();

        $settings = array_merge([
            'club_id' => $clubId,
            'enabled' => 0,
            'access_token' => null,
            'force_connect' => 1,
            'forward_messages_to_scolia' => 0,
            'disconnect_fallback_enabled' => 1,
            'queue_max_attempts' => 8,
            'queue_retry_base_seconds' => 2,
            'event_retention_days' => 30,
        ], $row);

        $token = trim((string) ($settings['access_token'] ?? ''));
        if (!$includeSecret) {
            unset($settings['access_token']);
            $settings['access_token_configured'] = $token !== '';
            $settings['access_token_masked'] = $token === '' ? '' : ('••••••••' . substr($token, -4));
        }
        return $settings;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubSettings(int $clubId, array $payload, int $userId): array
    {
        $current = $this->getClubSettings($clubId, true);
        $token = array_key_exists('access_token', $payload)
            ? trim((string) $payload['access_token'])
            : (string) ($current['access_token'] ?? '');
        if ($token === '********' || str_starts_with($token, '••••')) {
            $token = (string) ($current['access_token'] ?? '');
        }
        $enabled = $this->boolInt($payload['enabled'] ?? $current['enabled']);
        $force = $this->boolInt($payload['force_connect'] ?? $current['force_connect']);
        $forward = $this->boolInt($payload['forward_messages_to_scolia'] ?? $current['forward_messages_to_scolia']);
        $fallback = $this->boolInt($payload['disconnect_fallback_enabled'] ?? $current['disconnect_fallback_enabled']);
        $maxAttempts = min(20, max(1, (int) ($payload['queue_max_attempts'] ?? $current['queue_max_attempts'])));
        $retryBase = min(300, max(1, (int) ($payload['queue_retry_base_seconds'] ?? $current['queue_retry_base_seconds'])));
        $retention = min(365, max(1, (int) ($payload['event_retention_days'] ?? $current['event_retention_days'])));

        $sql = sprintf(
            'INSERT INTO `%1$sscolia_club_settings`
             (club_id,enabled,access_token,force_connect,forward_messages_to_scolia,disconnect_fallback_enabled,
              queue_max_attempts,queue_retry_base_seconds,event_retention_days,updated_by_user_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),access_token=VALUES(access_token),
              force_connect=VALUES(force_connect),forward_messages_to_scolia=VALUES(forward_messages_to_scolia),
              disconnect_fallback_enabled=VALUES(disconnect_fallback_enabled),queue_max_attempts=VALUES(queue_max_attempts),
              queue_retry_base_seconds=VALUES(queue_retry_base_seconds),event_retention_days=VALUES(event_retention_days),
              updated_by_user_id=VALUES(updated_by_user_id)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iisiiiiiii', $clubId, $enabled, $token, $force, $forward, $fallback, $maxAttempts, $retryBase, $retention, $userId);
        $stmt->execute();
        $stmt->close();
        return $this->getClubSettings($clubId, false);
    }

    /** @return array<string,mixed>|null */
    public function getBoardSettings(int $clubId, int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
                    s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override,
                    r.connection_state,r.board_status,r.board_phase,r.error_type,r.fallback_active,r.needs_reconciliation,
                    r.turn_locked_until_takeout,r.last_disconnect_reason,r.last_bridge_heartbeat_at,r.connected_at,
                    r.last_event_at,r.last_disconnect_at,r.last_reconciled_at
             FROM `%1$skiosks` k
             LEFT JOIN `%1$sscolia_board_settings` s ON s.kiosk_id=k.id
             LEFT JOIN `%1$sscolia_board_runtime` r ON r.kiosk_id=k.id
             WHERE k.club_id=? AND k.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $clubId, $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;
        $row['mode'] = $row['mode'] ?? ((string) ($row['scoring_mode'] ?? '') === 'scolia' ? 'live' : 'off');
        $row['auto_fallback_to_manual'] = $row['auto_fallback_to_manual'] ?? 1;
        $row['connection_state'] = $row['connection_state'] ?? 'disconnected';
        $row['fallback_active'] = (int) ($row['fallback_active'] ?? 0);
        $row['needs_reconciliation'] = (int) ($row['needs_reconciliation'] ?? 0);
        $row['turn_locked_until_takeout'] = (int) ($row['turn_locked_until_takeout'] ?? 0);
        return $row;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed>|null */
    public function updateBoardSettings(int $clubId, int $kioskId, array $payload, int $userId): ?array
    {
        $current = $this->getBoardSettings($clubId, $kioskId);
        if ($current === null) return null;
        $serial = array_key_exists('serial_number', $payload) ? trim((string) $payload['serial_number']) : trim((string) ($current['serial_number'] ?? ''));
        $serial = $serial === '' ? null : $serial;
        $mode = strtolower(trim((string) ($payload['mode'] ?? $current['mode'] ?? 'off')));
        if (!in_array($mode, ['off','shadow','live'], true)) {
            throw new ValidationException('invalid_scolia_mode', 'Scolia-modus må være off, shadow eller live.');
        }
        if ($mode !== 'off' && $serial === null) {
            throw new ValidationException('scolia_serial_required', 'Serialnummer må settes før Scolia kan aktiveres.');
        }
        $autoFallback = $this->boolInt($payload['auto_fallback_to_manual'] ?? $current['auto_fallback_to_manual'] ?? 1);
        $forceOverride = array_key_exists('force_connect_override', $payload) ? $this->nullableBoolInt($payload['force_connect_override']) : $this->nullableBoolInt($current['force_connect_override'] ?? null);
        $forwardOverride = array_key_exists('forward_messages_override', $payload) ? $this->nullableBoolInt($payload['forward_messages_override']) : $this->nullableBoolInt($current['forward_messages_override'] ?? null);

        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_settings`
             (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
             VALUES (?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE serial_number=VALUES(serial_number),mode=VALUES(mode),
              auto_fallback_to_manual=VALUES(auto_fallback_to_manual),force_connect_override=VALUES(force_connect_override),
              forward_messages_override=VALUES(forward_messages_override),updated_by_user_id=VALUES(updated_by_user_id)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('issiiii', $kioskId, $serial, $mode, $autoFallback, $forceOverride, $forwardOverride, $userId);
        $stmt->execute();
        $stmt->close();

        $runtimeState = $mode === 'off' ? 'disabled' : 'disconnected';
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,connection_state) VALUES (?,?)
             ON DUPLICATE KEY UPDATE connection_state=IF(?="disabled","disabled",IF(connection_state="disabled","disconnected",connection_state))',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iss', $kioskId, $runtimeState, $runtimeState);
        $stmt->execute();
        $stmt->close();
        return $this->getBoardSettings($clubId, $kioskId);
    }

    /** @return array<int,array<string,mixed>> */
    public function listBridgeBoards(): array
    {
        $sql = sprintf(
            'SELECT k.id AS kiosk_id,k.club_id,k.code,k.name,k.board_number,s.serial_number,s.mode,s.auto_fallback_to_manual,
                    s.force_connect_override,s.forward_messages_override,c.enabled,c.access_token,c.force_connect,
                    c.forward_messages_to_scolia,c.disconnect_fallback_enabled
             FROM `%1$sscolia_board_settings` s
             INNER JOIN `%1$skiosks` k ON k.id=s.kiosk_id AND k.is_active=1
             INNER JOIN `%1$sscolia_club_settings` c ON c.club_id=k.club_id AND c.enabled=1
             WHERE s.mode IN ("shadow","live") AND s.serial_number IS NOT NULL AND s.serial_number<>""
             ORDER BY k.club_id,k.board_number,k.id',
            $this->tablePrefix
        );
        $result = $this->connection->query($sql);
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        foreach ($rows as &$row) {
            $row['force_connect'] = $row['force_connect_override'] === null ? (int) $row['force_connect'] : (int) $row['force_connect_override'];
            $row['forward_messages_to_scolia'] = $row['forward_messages_override'] === null
                ? (int) $row['forward_messages_to_scolia'] : (int) $row['forward_messages_override'];
            unset($row['force_connect_override'], $row['forward_messages_override']);
        }
        unset($row);
        return $rows;
    }

    /** @return array<string,mixed>|null */
    public function findBoardBySerial(string $serial): ?array
    {
        $sql = sprintf(
            'SELECT k.id AS kiosk_id,k.club_id,k.code,k.name,k.board_number,s.serial_number,s.mode,s.auto_fallback_to_manual,
                    c.disconnect_fallback_enabled,c.queue_max_attempts,c.queue_retry_base_seconds
             FROM `%1$sscolia_board_settings` s
             INNER JOIN `%1$skiosks` k ON k.id=s.kiosk_id
             LEFT JOIN `%1$sscolia_club_settings` c ON c.club_id=k.club_id
             WHERE s.serial_number=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('s', $serial);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string,mixed> $message @return array{id:int,duplicate:bool} */
    public function enqueueEvent(string $serial, array $message): array
    {
        $board = $this->findBoardBySerial($serial);
        if ($board === null) {
            throw new ValidationException('scolia_board_not_mapped', 'Scolia-serialnummeret er ikke koblet til en Blindleia-skive.', 404);
        }
        $providerId = trim((string) ($message['id'] ?? ''));
        $type = strtoupper(trim((string) ($message['type'] ?? 'UNKNOWN')));
        $payload = is_array($message['payload'] ?? null) ? $message['payload'] : [];
        $dedupeBasis = $providerId !== ''
            ? 'id:' . $serial . ':' . $providerId
            : 'payload:' . $serial . ':' . $type . ':' . json_encode($message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $dedupeKey = hash('sha256', $dedupeBasis);
        $payloadJson = json_encode($message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $detectedAt = $this->providerDateTime($payload['detectionTime'] ?? $payload['detection_time'] ?? null);
        $matchId = $this->activeMatchId((int) $board['kiosk_id'], true);

        $sql = sprintf(
            'INSERT IGNORE INTO `%1$sscolia_events`
             (club_id,kiosk_id,match_id,provider_event_id,dedupe_key,event_type,provider_detected_at,payload_json)
             VALUES (?,?,?,?,?,?,?,?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $clubId = (int) $board['club_id'];
        $kioskId = (int) $board['kiosk_id'];
        $providerIdValue = $providerId !== '' ? $providerId : null;
        $stmt->bind_param('iiisssss', $clubId, $kioskId, $matchId, $providerIdValue, $dedupeKey, $type, $detectedAt, $payloadJson);
        $stmt->execute();
        $inserted = $stmt->affected_rows > 0;
        $id = $inserted ? (int) $stmt->insert_id : 0;
        $stmt->close();
        if (!$inserted) {
            $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sscolia_events` WHERE dedupe_key=? LIMIT 1', $this->tablePrefix));
            $stmt->bind_param('s', $dedupeKey);
            $stmt->execute();
            $id = (int) (($stmt->get_result()->fetch_assoc()['id'] ?? 0));
            $stmt->close();
        }
        $this->touchRuntimeEvent($kioskId);
        return ['id' => $id, 'duplicate' => !$inserted];
    }

    /** @return array<int,array<string,mixed>> */
    public function claimQueuedEvents(int $limit = 25): array
    {
        $limit = min(100, max(1, $limit));
        $rows = [];
        $this->connection->begin_transaction();
        try {
            $sql = sprintf(
                'SELECT * FROM `%1$sscolia_events`
                 WHERE processing_status IN ("queued","failed") AND next_attempt_at<=NOW(3)
                 ORDER BY id ASC LIMIT %2$d FOR UPDATE',
                $this->tablePrefix,
                $limit
            );
            $result = $this->connection->query($sql);
            $rows = $result->fetch_all(MYSQLI_ASSOC);
            if ($rows !== []) {
                $ids = implode(',', array_map(static fn(array $row): int => (int) $row['id'], $rows));
                $this->connection->query(sprintf(
                    'UPDATE `%1$sscolia_events` SET processing_status="processing",attempt_count=attempt_count+1 WHERE id IN (%2$s)',
                    $this->tablePrefix,
                    $ids
                ));
            }
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
        foreach ($rows as &$row) {
            $row['payload'] = json_decode((string) $row['payload_json'], true) ?: [];
            $row['attempt_count'] = (int) $row['attempt_count'] + 1;
        }
        unset($row);
        return $rows;
    }

    /** @param array<string,mixed>|null $meta */
    public function markEventProcessed(int $eventId, string $status = 'processed', ?int $visitId = null, ?array $meta = null): void
    {
        if (!in_array($status, ['processed','ignored'], true)) $status = 'processed';
        $metaJson = $meta === null ? null : json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $sql = sprintf(
            'UPDATE `%1$sscolia_events` SET processing_status=?,processed_at=NOW(3),last_error=NULL,canonical_visit_id=?,processing_meta_json=? WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('sisi', $status, $visitId, $metaJson, $eventId);
        $stmt->execute();
        $stmt->close();
    }

    public function markEventFailed(array $event, Throwable $error): void
    {
        $attempts = (int) ($event['attempt_count'] ?? 1);
        $board = $this->getBoardById((int) $event['kiosk_id']);
        $clubSettings = $board === null ? [] : $this->getClubSettings((int) $board['club_id'], true);
        $max = (int) ($clubSettings['queue_max_attempts'] ?? 8);
        $base = (int) ($clubSettings['queue_retry_base_seconds'] ?? 2);
        $dead = $attempts >= $max;
        $status = $dead ? 'dead_letter' : 'failed';
        $delay = min(900, $base * (2 ** min(8, max(0, $attempts - 1))));
        $next = (new DateTimeImmutable('+' . $delay . ' seconds'))->format('Y-m-d H:i:s.v');
        $message = mb_substr($error->getMessage(), 0, 6000);
        $sql = sprintf('UPDATE `%1$sscolia_events` SET processing_status=?,next_attempt_at=?,last_error=? WHERE id=?', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $id = (int) $event['id'];
        $stmt->bind_param('sssi', $status, $next, $message, $id);
        $stmt->execute();
        $stmt->close();
        $this->recordIncident(
            (int) $event['club_id'],
            (int) $event['kiosk_id'],
            isset($event['match_id']) ? (int) $event['match_id'] : null,
            $dead ? 'critical' : 'error',
            $dead ? 'dead_letter' : 'event_processing',
            $dead ? 'Scolia-event havnet i dead-letter-kø' : 'Scolia-event kunne ikke behandles',
            $message,
            ['event_id' => $id, 'event_type' => $event['event_type'] ?? null, 'attempt_count' => $attempts]
        );
    }

    /** @return array<string,mixed>|null */
    public function getScoringContext(int $kioskId): ?array
    {
        $matchSql = sprintf(
            'SELECT id,tournament_id,kiosk_id,status,player_a_id,player_b_id FROM `%1$smatches`
             WHERE kiosk_id=? AND status IN ("in_progress","assigned")
             ORDER BY FIELD(status,"in_progress","assigned"),id ASC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($matchSql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($match === null) return null;

        $legSql = sprintf(
            'SELECT id,leg_number,starting_player_id,start_score,status FROM `%1$slegs`
             WHERE match_id=? AND status IN ("pending","in_progress") ORDER BY leg_number DESC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($legSql);
        $matchId = (int) $match['id'];
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $leg = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($leg === null) return null;

        $stmt = $this->connection->prepare(sprintf('SELECT COUNT(*) AS c FROM `%1$svisits` WHERE leg_id=?', $this->tablePrefix));
        $legId = (int) $leg['id'];
        $stmt->bind_param('i', $legId);
        $stmt->execute();
        $totalVisits = (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
        $stmt->close();
        $starter = (int) $leg['starting_player_id'];
        $other = $starter === (int) $match['player_a_id'] ? (int) $match['player_b_id'] : (int) $match['player_a_id'];
        $playerId = $totalVisits % 2 === 0 ? $starter : $other;
        $startScore = (int) ($leg['start_score'] ?? 501);
        $remaining = $startScore;
        $stmt = $this->connection->prepare(sprintf(
            'SELECT score,is_bust FROM `%1$svisits` WHERE leg_id=? AND player_id=? ORDER BY id',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $legId, $playerId);
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            if ((int) $row['is_bust'] !== 1) $remaining -= (int) $row['score'];
        }
        $stmt->close();
        return [
            'match_id' => $matchId,
            'tournament_id' => (int) $match['tournament_id'],
            'leg_id' => $legId,
            'leg_number' => (int) $leg['leg_number'],
            'player_id' => $playerId,
            'remaining' => $remaining,
        ];
    }

    /** @return array<string,mixed>|null */
    public function getVisitBuffer(int $kioskId): ?array
    {
        $stmt = $this->connection->prepare(sprintf('SELECT * FROM `%1$sscolia_visit_buffers` WHERE kiosk_id=? LIMIT 1', $this->tablePrefix));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null) {
            $row['darts'] = json_decode((string) $row['darts_json'], true) ?: [];
            $row['event_ids'] = json_decode((string) $row['event_ids_json'], true) ?: [];
            $row['provider_event_ids'] = json_decode((string) ($row['provider_event_ids_json'] ?? '[]'), true) ?: [];
        }
        return $row;
    }

    /** @param array<int,array<string,mixed>> $darts @param array<int,int> $eventIds @param array<int,string> $providerIds */
    public function saveVisitBuffer(int $kioskId, int $matchId, int $playerId, array $darts, array $eventIds, array $providerIds): void
    {
        $dartsJson = json_encode(array_values($darts), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $eventIdsJson = json_encode(array_values($eventIds));
        $providerIdsJson = json_encode(array_values($providerIds));
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_visit_buffers` (kiosk_id,match_id,player_id,darts_json,event_ids_json,provider_event_ids_json)
             VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE match_id=VALUES(match_id),player_id=VALUES(player_id),darts_json=VALUES(darts_json),
              event_ids_json=VALUES(event_ids_json),provider_event_ids_json=VALUES(provider_event_ids_json),updated_at=NOW(3)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiisss', $kioskId, $matchId, $playerId, $dartsJson, $eventIdsJson, $providerIdsJson);
        $stmt->execute();
        $stmt->close();
    }

    public function clearVisitBuffer(int $kioskId): void
    {
        $stmt = $this->connection->prepare(sprintf('DELETE FROM `%1$sscolia_visit_buffers` WHERE kiosk_id=?', $this->tablePrefix));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<int,array<string,mixed>> $darts @param array<int,int> $eventIds */
    public function storeShadowVisit(int $kioskId, int $matchId, int $playerId, array $darts, array $eventIds, array $evaluation, int $remainingBefore): int
    {
        $dartsJson = json_encode($darts, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $idsJson = json_encode($eventIds);
        $score = (int) $evaluation['score'];
        $used = (int) $evaluation['darts_used'];
        $bust = !empty($evaluation['is_bust']) ? 1 : 0;
        $checkout = !empty($evaluation['is_checkout']) ? 1 : 0;
        $after = (int) $evaluation['remaining_after'];
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_shadow_visits`
             (kiosk_id,match_id,player_id,darts_json,score,darts_used,is_bust,is_checkout,remaining_before,remaining_after,source_event_ids_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiisiiiiiss', $kioskId, $matchId, $playerId, $dartsJson, $score, $used, $bust, $checkout, $remainingBefore, $after, $idsJson);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    public function findVisitByRequestKey(string $requestKey): ?int
    {
        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$svisits` WHERE request_key=? LIMIT 1', $this->tablePrefix));
        $stmt->bind_param('s', $requestKey);
        $stmt->execute();
        $id = $stmt->get_result()->fetch_assoc()['id'] ?? null;
        $stmt->close();
        return $id === null ? null : (int) $id;
    }

    /** @param array<string,mixed> $payload */
    public function queueCommand(int $clubId, int $kioskId, string $type, array $payload = [], ?int $userId = null): array
    {
        $messageId = $this->uuidV4();
        $payloadJson = $payload === [] ? null : json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_commands` (club_id,kiosk_id,command_type,message_id,payload_json,created_by_user_id)
             VALUES (?,?,?,?,?,?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iisssi', $clubId, $kioskId, $type, $messageId, $payloadJson, $userId);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return ['id' => $id, 'message_id' => $messageId, 'type' => $type, 'payload' => $payload];
    }

    /** @return array<int,array<string,mixed>> */
    public function pollCommands(int $kioskId, int $limit = 20): array
    {
        $limit = min(50, max(1, $limit));
        $sql = sprintf(
            'SELECT id,command_type,message_id,payload_json,attempt_count,created_at FROM `%1$sscolia_commands`
             WHERE kiosk_id=? AND status IN ("queued","failed") AND next_attempt_at<=NOW(3)
             ORDER BY id LIMIT %2$d',
            $this->tablePrefix,
            $limit
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $id = (int) $row['id'];
            $update = $this->connection->prepare(sprintf(
                'UPDATE `%1$sscolia_commands` SET status="delivered",attempt_count=attempt_count+1,delivered_at=NOW(3) WHERE id=?',
                $this->tablePrefix
            ));
            $update->bind_param('i', $id);
            $update->execute();
            $update->close();
            $row['payload'] = json_decode((string) ($row['payload_json'] ?? '{}'), true) ?: [];
            unset($row['payload_json']);
        }
        unset($row);
        return $rows;
    }

    public function completeCommand(int $commandId, string $result, ?string $error = null): void
    {
        $status = match (strtolower($result)) {
            'acked', 'ack' => 'acked',
            'refused' => 'refused',
            default => 'failed',
        };
        $next = (new DateTimeImmutable('+3 seconds'))->format('Y-m-d H:i:s.v');
        $sql = sprintf(
            'UPDATE `%1$sscolia_commands` SET status=?,completed_at=IF(? IN ("acked","refused"),NOW(3),NULL),last_error=?,next_attempt_at=? WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssssi', $status, $status, $error, $next, $commandId);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<string,mixed> $payload */
    public function updateRuntimeFromHello(int $kioskId, array $payload): void
    {
        $status = $this->firstString($payload, ['boardStatus','board_status','status']);
        $phase = $this->firstString($payload, ['boardPhase','board_phase','phase']);
        $error = $this->firstString($payload, ['errorType','error_type','error']);
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,connection_state,board_status,board_phase,error_type,connected_at,last_event_at)
             VALUES (?,"connected",?,?,?,NOW(3),NOW(3))
             ON DUPLICATE KEY UPDATE connection_state="connected",board_status=VALUES(board_status),board_phase=VALUES(board_phase),
              error_type=VALUES(error_type),connected_at=COALESCE(connected_at,NOW(3)),last_event_at=NOW(3)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isss', $kioskId, $status, $phase, $error);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<string,mixed> $payload */
    public function updateRuntimeStatus(int $kioskId, array $payload): void
    {
        $status = $this->firstString($payload, ['boardStatus','board_status','status']);
        $phase = $this->firstString($payload, ['boardPhase','board_phase','phase']);
        $error = $this->firstString($payload, ['errorType','error_type','error']);
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,connection_state,board_status,board_phase,error_type,last_event_at)
             VALUES (?,"connected",?,?,?,NOW(3))
             ON DUPLICATE KEY UPDATE connection_state="connected",board_status=COALESCE(VALUES(board_status),board_status),
              board_phase=COALESCE(VALUES(board_phase),board_phase),error_type=VALUES(error_type),last_event_at=NOW(3)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isss', $kioskId, $status, $phase, $error);
        $stmt->execute();
        $stmt->close();
    }

    public function bridgeHeartbeat(int $kioskId, string $state = 'connected'): void
    {
        $state = in_array($state, ['connecting','connected','disconnected','error'], true) ? $state : 'connected';
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,connection_state,last_bridge_heartbeat_at)
             VALUES (?,?,NOW(3))
             ON DUPLICATE KEY UPDATE connection_state=?,last_bridge_heartbeat_at=NOW(3)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iss', $kioskId, $state, $state);
        $stmt->execute();
        $stmt->close();
    }

    public function markDisconnected(int $kioskId, string $reason): void
    {
        $board = $this->getBoardById($kioskId);
        if ($board === null) return;
        $settings = $this->getBoardSettings((int) $board['club_id'], $kioskId);
        $activeMatchId = $this->activeMatchId($kioskId, false);
        $fallback = $activeMatchId !== null
            && ($settings['mode'] ?? 'off') === 'live'
            && (int) ($settings['auto_fallback_to_manual'] ?? 1) === 1;
        $fallbackInt = $fallback ? 1 : 0;
        $reconcile = $fallback ? 1 : 0;
        $reason = mb_substr($reason, 0, 255);
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime`
             (kiosk_id,connection_state,fallback_active,needs_reconciliation,last_disconnect_reason,last_disconnect_at,connected_at)
             VALUES (?,"disconnected",?,?,?,NOW(3),NULL)
             ON DUPLICATE KEY UPDATE connection_state="disconnected",fallback_active=GREATEST(fallback_active,VALUES(fallback_active)),
              needs_reconciliation=GREATEST(needs_reconciliation,VALUES(needs_reconciliation)),last_disconnect_reason=VALUES(last_disconnect_reason),
              last_disconnect_at=NOW(3),connected_at=NULL',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiis', $kioskId, $fallbackInt, $reconcile, $reason);
        $stmt->execute();
        $stmt->close();
        if ($fallback) {
            $this->recordIncident(
                (int) $board['club_id'],
                $kioskId,
                $activeMatchId,
                'critical',
                'connection_lost_during_match',
                'Scolia mistet forbindelsen under kamp – manuell fallback er aktiv',
                $reason,
                ['fallback_active' => true]
            );
        }
    }

    public function resumeScolia(int $clubId, int $kioskId, int $userId): void
    {
        $sql = sprintf(
            'UPDATE `%1$sscolia_board_runtime`
             SET fallback_active=0,needs_reconciliation=0,turn_locked_until_takeout=0,last_reconciled_at=NOW(3)
             WHERE kiosk_id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $stmt->close();
        $this->clearVisitBuffer($kioskId);
        $this->resolveIncidentsForKiosk($clubId, $kioskId, $userId, ['connection_lost_during_match','reconciliation_required']);
    }

    public function setTurnLocked(int $kioskId, bool $locked): void
    {
        $value = $locked ? 1 : 0;
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,turn_locked_until_takeout) VALUES (?,?)
             ON DUPLICATE KEY UPDATE turn_locked_until_takeout=VALUES(turn_locked_until_takeout)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $kioskId, $value);
        $stmt->execute();
        $stmt->close();
    }

    public function isTurnLocked(int $kioskId): bool
    {
        $stmt = $this->connection->prepare(sprintf('SELECT turn_locked_until_takeout FROM `%1$sscolia_board_runtime` WHERE kiosk_id=?', $this->tablePrefix));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $value = (int) ($stmt->get_result()->fetch_assoc()['turn_locked_until_takeout'] ?? 0);
        $stmt->close();
        return $value === 1;
    }

    /** @return array<string,mixed> */
    public function getBoardRuntimeStatus(int $clubId, int $kioskId): array
    {
        $board = $this->getBoardSettings($clubId, $kioskId);
        if ($board === null) throw new ValidationException('kiosk_not_found', 'Boardet ble ikke funnet.', 404);
        $buffer = $this->getVisitBuffer($kioskId);
        $queue = $this->queueCounts($clubId, $kioskId);
        $board['effective_scoring_mode'] = ((int) ($board['fallback_active'] ?? 0) === 1 || (int) ($board['needs_reconciliation'] ?? 0) === 1)
            ? 'manual' : (($board['mode'] ?? 'off') === 'live' ? 'scolia' : 'manual');
        $board['buffer'] = $buffer === null ? null : [
            'match_id' => (int) $buffer['match_id'],
            'player_id' => (int) $buffer['player_id'],
            'darts' => $buffer['darts'],
            'updated_at' => $buffer['updated_at'],
        ];
        $board['queue'] = $queue;
        return $board;
    }

    /** @return array<string,mixed> */
    public function adminDashboard(int $clubId): array
    {
        $boardsSql = sprintf(
            'SELECT k.id,k.code,k.name,k.board_number,s.serial_number,s.mode,s.auto_fallback_to_manual,
                    r.connection_state,r.board_status,r.board_phase,r.error_type,r.fallback_active,r.needs_reconciliation,
                    r.last_bridge_heartbeat_at,r.last_event_at,r.last_disconnect_at,r.last_disconnect_reason
             FROM `%1$skiosks` k
             LEFT JOIN `%1$sscolia_board_settings` s ON s.kiosk_id=k.id
             LEFT JOIN `%1$sscolia_board_runtime` r ON r.kiosk_id=k.id
             WHERE k.club_id=? ORDER BY k.board_number,k.id',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($boardsSql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $boards = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $incidentSql = sprintf(
            'SELECT i.*,k.name AS kiosk_name,k.board_number FROM `%1$sscolia_incidents` i
             LEFT JOIN `%1$skiosks` k ON k.id=i.kiosk_id
             WHERE i.club_id=? AND i.status="open" ORDER BY FIELD(i.severity,"critical","error","warning","info"),i.last_seen_at DESC LIMIT 100',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($incidentSql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $incidents = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $eventSql = sprintf(
            'SELECT e.id,e.kiosk_id,k.board_number,e.match_id,e.event_type,e.processing_status,e.attempt_count,e.received_at,e.last_error
             FROM `%1$sscolia_events` e INNER JOIN `%1$skiosks` k ON k.id=e.kiosk_id
             WHERE e.club_id=? AND e.processing_status IN ("failed","dead_letter") ORDER BY e.id DESC LIMIT 100',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($eventSql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $failed = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        return [
            'settings' => $this->getClubSettings($clubId),
            'queue' => $this->queueCounts($clubId, null),
            'boards' => $boards,
            'incidents' => $incidents,
            'failed_events' => $failed,
        ];
    }

    public function resolveIncident(int $clubId, int $incidentId, int $userId): bool
    {
        $sql = sprintf(
            'UPDATE `%1$sscolia_incidents` SET status="resolved",resolved_at=NOW(3),resolved_by_user_id=?
             WHERE id=? AND club_id=? AND status="open"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $userId, $incidentId, $clubId);
        $stmt->execute();
        $changed = $stmt->affected_rows > 0;
        $stmt->close();
        return $changed;
    }

    /** @param array<string,mixed>|null $context */
    public function recordIncident(int $clubId, ?int $kioskId, ?int $matchId, string $severity, string $category, string $summary, ?string $details = null, ?array $context = null): void
    {
        $severity = in_array($severity, ['info','warning','error','critical'], true) ? $severity : 'warning';
        $contextJson = $context === null ? null : json_encode($context, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $select = sprintf(
            'SELECT id FROM `%1$sscolia_incidents` WHERE club_id=? AND status="open" AND category=? AND ((kiosk_id IS NULL AND ? IS NULL) OR kiosk_id=?) LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($select);
        $stmt->bind_param('isii', $clubId, $category, $kioskId, $kioskId);
        $stmt->execute();
        $existing = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($existing !== null) {
            $sql = sprintf(
                'UPDATE `%1$sscolia_incidents` SET severity=?,summary=?,details=?,context_json=?,match_id=COALESCE(?,match_id),
                 last_seen_at=NOW(3),occurrence_count=occurrence_count+1 WHERE id=?',
                $this->tablePrefix
            );
            $stmt = $this->connection->prepare($sql);
            $id = (int) $existing['id'];
            $stmt->bind_param('ssssii', $severity, $summary, $details, $contextJson, $matchId, $id);
            $stmt->execute();
            $stmt->close();
            return;
        }
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_incidents` (club_id,kiosk_id,match_id,severity,category,summary,details,context_json)
             VALUES (?,?,?,?,?,?,?,?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiisssss', $clubId, $kioskId, $matchId, $severity, $category, $summary, $details, $contextJson);
        $stmt->execute();
        $stmt->close();
    }

    public function retryDeadLetter(int $clubId, int $eventId): bool
    {
        $sql = sprintf(
            'UPDATE `%1$sscolia_events` SET processing_status="queued",attempt_count=0,next_attempt_at=NOW(3),last_error=NULL
             WHERE id=? AND club_id=? AND processing_status="dead_letter"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $eventId, $clubId);
        $stmt->execute();
        $changed = $stmt->affected_rows > 0;
        $stmt->close();
        return $changed;
    }

    /** @return array<string,int> */
    public function queueCounts(int $clubId, ?int $kioskId): array
    {
        $where = $kioskId === null ? 'club_id=?' : 'club_id=? AND kiosk_id=?';
        $sql = sprintf(
            'SELECT processing_status,COUNT(*) AS c FROM `%1$sscolia_events` WHERE %2$s GROUP BY processing_status',
            $this->tablePrefix,
            $where
        );
        $stmt = $this->connection->prepare($sql);
        if ($kioskId === null) $stmt->bind_param('i', $clubId); else $stmt->bind_param('ii', $clubId, $kioskId);
        $stmt->execute();
        $result = $stmt->get_result();
        $counts = ['queued'=>0,'processing'=>0,'processed'=>0,'ignored'=>0,'failed'=>0,'dead_letter'=>0];
        while ($row = $result->fetch_assoc()) $counts[(string) $row['processing_status']] = (int) $row['c'];
        $stmt->close();
        return $counts;
    }

    public function cleanupOldEvents(int $clubId): int
    {
        $settings = $this->getClubSettings($clubId, true);
        $days = (int) ($settings['event_retention_days'] ?? 30);
        $sql = sprintf(
            'DELETE FROM `%1$sscolia_events` WHERE club_id=? AND processing_status IN ("processed","ignored") AND received_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $clubId, $days);
        $stmt->execute();
        $count = $stmt->affected_rows;
        $stmt->close();
        return $count;
    }

    /** @return array<string,mixed>|null */
    private function getBoardById(int $kioskId): ?array
    {
        $stmt = $this->connection->prepare(sprintf('SELECT id,club_id,code,name,board_number FROM `%1$skiosks` WHERE id=? LIMIT 1', $this->tablePrefix));
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function activeMatchId(int $kioskId, bool $includeAssigned): ?int
    {
        $statuses = $includeAssigned ? '("in_progress","assigned")' : '("in_progress")';
        $sql = sprintf('SELECT id FROM `%1$smatches` WHERE kiosk_id=? AND status IN %2$s ORDER BY FIELD(status,"in_progress","assigned"),id LIMIT 1', $this->tablePrefix, $statuses);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $value = $stmt->get_result()->fetch_assoc()['id'] ?? null;
        $stmt->close();
        return $value === null ? null : (int) $value;
    }

    private function touchRuntimeEvent(int $kioskId): void
    {
        $sql = sprintf(
            'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,last_event_at) VALUES (?,NOW(3))
             ON DUPLICATE KEY UPDATE last_event_at=NOW(3)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $kioskId);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<int,string> $categories */
    private function resolveIncidentsForKiosk(int $clubId, int $kioskId, int $userId, array $categories): void
    {
        if ($categories === []) return;
        $quoted = implode(',', array_fill(0, count($categories), '?'));
        $types = 'iii' . str_repeat('s', count($categories));
        $sql = sprintf(
            'UPDATE `%1$sscolia_incidents` SET status="resolved",resolved_at=NOW(3),resolved_by_user_id=?
             WHERE club_id=? AND kiosk_id=? AND status="open" AND category IN (%2$s)',
            $this->tablePrefix,
            $quoted
        );
        $stmt = $this->connection->prepare($sql);
        $params = [$userId, $clubId, $kioskId, ...$categories];
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<string,mixed> $payload @param array<int,string> $keys */
    private function firstString(array $payload, array $keys): ?string
    {
        foreach ($keys as $key) {
            if (isset($payload[$key]) && trim((string) $payload[$key]) !== '') return trim((string) $payload[$key]);
        }
        return null;
    }

    private function providerDateTime(mixed $value): ?string
    {
        if (!is_string($value) || trim($value) === '') return null;
        try { return (new DateTimeImmutable($value))->format('Y-m-d H:i:s.v'); } catch (Throwable) { return null; }
    }

    private function boolInt(mixed $value): int
    {
        if (is_bool($value)) return $value ? 1 : 0;
        return in_array(strtolower(trim((string) $value)), ['1','true','yes','on'], true) ? 1 : 0;
    }

    private function nullableBoolInt(mixed $value): ?int
    {
        if ($value === null || $value === '') return null;
        return $this->boolInt($value);
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
