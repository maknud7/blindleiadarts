<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Canonical Scolia master data.
 *
 * Physical boards, Scolia serial numbers and the club service-account token live
 * in HARDWARE_TABLE_PREFIX (bd_prod_ in deployed TEST and PROD). Runtime state,
 * events, commands and scoring continue to live in the active environment.
 */
final class ScoliaHardwareSettingsRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $hardwarePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->hardwarePrefix = $database->hardwareTablePrefix();
        foreach ([$this->dataPrefix, $this->hardwarePrefix] as $prefix) {
            if (preg_match('/^[A-Za-z0-9_]+$/', $prefix) !== 1) {
                throw new \RuntimeException('Invalid Scolia table prefix.');
            }
        }
    }

    /** @return array<string,mixed> */
    public function scope(): array
    {
        return [
            'configuration_scope' => 'production_hardware',
            'shared_across_environments' => true,
            'configuration_table_prefix' => $this->hardwarePrefix,
            'runtime_table_prefix' => $this->dataPrefix,
        ];
    }

    /** @return array<string,mixed> */
    public function getClubSettings(int $environmentClubId, bool $includeSecret = false): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $sql = sprintf('SELECT * FROM `%1$sscolia_club_settings` WHERE club_id=? LIMIT 1', $this->hardwarePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $canonicalClubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();

        $settings = array_merge([
            'club_id' => $environmentClubId,
            'canonical_club_id' => $canonicalClubId,
            'enabled' => 0,
            'access_token' => null,
            'force_connect' => 1,
            'forward_messages_to_scolia' => 0,
            'disconnect_fallback_enabled' => 1,
            'queue_max_attempts' => 8,
            'queue_retry_base_seconds' => 2,
            'event_retention_days' => 30,
        ], $row, $this->scope());
        $settings['club_id'] = $environmentClubId;
        $settings['canonical_club_id'] = $canonicalClubId;

        $token = trim((string) ($settings['access_token'] ?? ''));
        if (!$includeSecret) {
            unset($settings['access_token']);
            $settings['access_token_configured'] = $token !== '';
            $settings['access_token_masked'] = $token === '' ? '' : ('••••••••' . substr($token, -4));
        }
        return $settings;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubSettings(int $environmentClubId, array $payload, int $userId): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $current = $this->getClubSettings($environmentClubId, true);
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
            $this->hardwarePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iisiiiiiii', $canonicalClubId, $enabled, $token, $force, $forward, $fallback, $maxAttempts, $retryBase, $retention, $userId);
        $stmt->execute();
        $stmt->close();

        return $this->getClubSettings($environmentClubId, false);
    }

    /** @return array<string,mixed>|null */
    public function getBoardSettings(int $environmentClubId, int $kioskId): ?array
    {
        $resolved = $this->resolvePhysicalBoard($environmentClubId, $kioskId);
        if ($resolved === null) return null;

        $physicalId = (int) $resolved['physical_kiosk_id'];
        $canonicalClubId = (int) $resolved['canonical_club_id'];
        $runtimeKioskId = isset($resolved['runtime_kiosk_id']) ? (int) $resolved['runtime_kiosk_id'] : null;

        $sql = sprintf(
            'SELECT k.id,k.club_id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
                    s.serial_number,s.mode,s.auto_fallback_to_manual,s.force_connect_override,s.forward_messages_override
             FROM `%1$skiosks` k
             LEFT JOIN `%1$sscolia_board_settings` s ON s.kiosk_id=k.id
             WHERE k.club_id=? AND k.id=? LIMIT 1',
            $this->hardwarePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $canonicalClubId, $physicalId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;

        $runtime = [];
        if ($runtimeKioskId !== null && $runtimeKioskId > 0) {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                        turn_locked_until_takeout,last_disconnect_reason,last_bridge_heartbeat_at,connected_at,
                        last_event_at,last_disconnect_at,last_reconciled_at
                 FROM `%1$sscolia_board_runtime` WHERE kiosk_id=? LIMIT 1',
                $this->dataPrefix
            ));
            $stmt->bind_param('i', $runtimeKioskId);
            $stmt->execute();
            $runtime = $stmt->get_result()->fetch_assoc() ?: [];
            $stmt->close();
        }

        $row = array_merge($row, $runtime, $this->scope());
        $row['id'] = $kioskId;
        $row['physical_kiosk_id'] = $physicalId;
        $row['runtime_kiosk_id'] = $runtimeKioskId;
        $row['environment_club_id'] = $environmentClubId;
        $row['canonical_club_id'] = $canonicalClubId;
        $row['mode'] = $row['mode'] ?? ((string) ($row['scoring_mode'] ?? '') === 'scolia' ? 'live' : 'off');
        $row['auto_fallback_to_manual'] = $row['auto_fallback_to_manual'] ?? 1;
        $row['connection_state'] = $row['connection_state'] ?? (($row['mode'] ?? 'off') === 'off' ? 'disabled' : 'disconnected');
        $row['fallback_active'] = (int) ($row['fallback_active'] ?? 0);
        $row['needs_reconciliation'] = (int) ($row['needs_reconciliation'] ?? 0);
        $row['turn_locked_until_takeout'] = (int) ($row['turn_locked_until_takeout'] ?? 0);
        return $row;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed>|null */
    public function updateBoardSettings(int $environmentClubId, int $kioskId, array $payload, int $userId): ?array
    {
        $current = $this->getBoardSettings($environmentClubId, $kioskId);
        if ($current === null) return null;

        $physicalId = (int) $current['physical_kiosk_id'];
        $serial = array_key_exists('serial_number', $payload)
            ? trim((string) $payload['serial_number'])
            : trim((string) ($current['serial_number'] ?? ''));
        $serial = $serial === '' ? null : strtoupper($serial);
        $mode = strtolower(trim((string) ($payload['mode'] ?? $current['mode'] ?? 'off')));
        if ($mode === 'shadow') $mode = 'live';
        if (!in_array($mode, ['off', 'live'], true)) {
            throw new ValidationException('invalid_scolia_mode', 'Scolia-board kan bare bruke live scoring.');
        }
        if ($mode === 'live' && $serial === null) {
            throw new ValidationException('scolia_serial_required', 'Serialnummer må settes før Scolia kan aktiveres.');
        }

        $autoFallback = $this->boolInt($payload['auto_fallback_to_manual'] ?? $current['auto_fallback_to_manual'] ?? 1);
        $forceOverride = array_key_exists('force_connect_override', $payload)
            ? $this->nullableBoolInt($payload['force_connect_override'])
            : $this->nullableBoolInt($current['force_connect_override'] ?? null);
        $forwardOverride = array_key_exists('forward_messages_override', $payload)
            ? $this->nullableBoolInt($payload['forward_messages_override'])
            : $this->nullableBoolInt($current['forward_messages_override'] ?? null);

        $this->connection->begin_transaction();
        try {
            if ($serial !== null) {
                $stmt = $this->connection->prepare(sprintf(
                    'SELECT kiosk_id FROM `%1$sscolia_board_settings` WHERE serial_number=? AND kiosk_id<>? LIMIT 1',
                    $this->hardwarePrefix
                ));
                $stmt->bind_param('si', $serial, $physicalId);
                $stmt->execute();
                $conflict = $stmt->get_result()->fetch_assoc() ?: null;
                $stmt->close();
                if ($conflict !== null) {
                    throw new ValidationException('scolia_serial_in_use', 'Dette Scolia-serienummeret er allerede koblet til en annen fysisk skive.', 409);
                }
            }

            $stmt = $this->connection->prepare(sprintf(
                'INSERT INTO `%1$sscolia_board_settings`
                 (kiosk_id,serial_number,mode,auto_fallback_to_manual,force_connect_override,forward_messages_override,updated_by_user_id)
                 VALUES (?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE serial_number=VALUES(serial_number),mode=VALUES(mode),
                  auto_fallback_to_manual=VALUES(auto_fallback_to_manual),force_connect_override=VALUES(force_connect_override),
                  forward_messages_override=VALUES(forward_messages_override),updated_by_user_id=VALUES(updated_by_user_id)',
                $this->hardwarePrefix
            ));
            $stmt->bind_param('issiiii', $physicalId, $serial, $mode, $autoFallback, $forceOverride, $forwardOverride, $userId);
            $stmt->execute();
            $stmt->close();

            $scoringMode = $mode === 'live' ? 'scolia' : 'manual';
            $stmt = $this->connection->prepare(sprintf('UPDATE `%1$skiosks` SET scoring_mode=? WHERE id=?', $this->hardwarePrefix));
            $stmt->bind_param('si', $scoringMode, $physicalId);
            $stmt->execute();
            $stmt->close();

            // PROD runtime uses the physical kiosk id. TEST runtime is controlled by
            // the explicit lease and must not be toggled merely because an admin edits
            // canonical hardware settings from the TEST UI.
            if ($this->dataPrefix === $this->hardwarePrefix) {
                $runtimeState = $mode === 'off' ? 'disabled' : 'disconnected';
                $stmt = $this->connection->prepare(sprintf(
                    'INSERT INTO `%1$sscolia_board_runtime` (kiosk_id,connection_state) VALUES (?,?)
                     ON DUPLICATE KEY UPDATE connection_state=IF(?="disabled","disabled",IF(connection_state="disabled","disconnected",connection_state))',
                    $this->dataPrefix
                ));
                $stmt->bind_param('iss', $physicalId, $runtimeState, $runtimeState);
                $stmt->execute();
                $stmt->close();
            }

            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->getBoardSettings($environmentClubId, $kioskId);
    }

    /** @return array<int,array<string,mixed>> */
    public function listBoards(int $environmentClubId): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $stmt = $this->connection->prepare(sprintf(
            'SELECT k.id,k.code,k.name,k.board_number,k.scoring_mode,k.is_active,
                    s.serial_number,s.mode,s.auto_fallback_to_manual
             FROM `%1$skiosks` k
             LEFT JOIN `%1$sscolia_board_settings` s ON s.kiosk_id=k.id
             WHERE k.club_id=? AND k.is_active=1 ORDER BY k.board_number,k.id',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('i', $canonicalClubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            $physicalId = (int) $row['id'];
            $runtimeId = $this->runtimeKioskId($environmentClubId, $physicalId);
            $runtime = [];
            if ($runtimeId !== null) {
                $stmt = $this->connection->prepare(sprintf(
                    'SELECT connection_state,board_status,board_phase,error_type,fallback_active,needs_reconciliation,
                            last_bridge_heartbeat_at,last_event_at,last_disconnect_at,last_disconnect_reason
                     FROM `%1$sscolia_board_runtime` WHERE kiosk_id=? LIMIT 1',
                    $this->dataPrefix
                ));
                $stmt->bind_param('i', $runtimeId);
                $stmt->execute();
                $runtime = $stmt->get_result()->fetch_assoc() ?: [];
                $stmt->close();
            }
            $row = array_merge($row, $runtime, $this->scope());
            $row['physical_kiosk_id'] = $physicalId;
            $row['runtime_kiosk_id'] = $runtimeId;
            $row['id'] = $runtimeId ?? $physicalId;
            $row['mode'] = $row['mode'] ?? ((string) ($row['scoring_mode'] ?? '') === 'scolia' ? 'live' : 'off');
            $row['connection_state'] = $row['connection_state'] ?? (($row['mode'] ?? 'off') === 'off' ? 'disabled' : 'disconnected');
            $row['fallback_active'] = (int) ($row['fallback_active'] ?? 0);
            $row['needs_reconciliation'] = (int) ($row['needs_reconciliation'] ?? 0);
        }
        unset($row);
        return $rows;
    }

    /** @return array<int,array<string,mixed>> */
    public function listBridgeBoards(): array
    {
        // A bridge connected directly to TEST must never open a second physical
        // WebSocket. TEST routing is granted only by the canonical PROD router.
        if ($this->dataPrefix !== $this->hardwarePrefix) return [];

        $sql = sprintf(
            'SELECT k.id AS kiosk_id,k.club_id,k.code,k.name,k.board_number,s.serial_number,s.mode,s.auto_fallback_to_manual,
                    s.force_connect_override,s.forward_messages_override,c.enabled,c.access_token,c.force_connect,
                    c.forward_messages_to_scolia,c.disconnect_fallback_enabled
             FROM `%1$sscolia_board_settings` s
             INNER JOIN `%1$skiosks` k ON k.id=s.kiosk_id AND k.is_active=1
             INNER JOIN `%1$sscolia_club_settings` c ON c.club_id=k.club_id AND c.enabled=1
             WHERE s.mode IN ("shadow","live") AND s.serial_number IS NOT NULL AND s.serial_number<>""
             ORDER BY k.club_id,k.board_number,k.id',
            $this->hardwarePrefix
        );
        $result = $this->connection->query($sql);
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        foreach ($rows as &$row) {
            $row['force_connect'] = $row['force_connect_override'] === null ? (int) $row['force_connect'] : (int) $row['force_connect_override'];
            $row['forward_messages_to_scolia'] = $row['forward_messages_override'] === null
                ? (int) $row['forward_messages_to_scolia'] : (int) $row['forward_messages_override'];
            $row = array_merge($row, $this->scope());
            unset($row['force_connect_override'], $row['forward_messages_override']);
        }
        unset($row);
        return $rows;
    }

    private function canonicalClubId(int $environmentClubId): int
    {
        if ($this->dataPrefix === $this->hardwarePrefix) return $environmentClubId;

        $stmt = $this->connection->prepare(sprintf('SELECT slug FROM `%1$sclubs` WHERE id=? LIMIT 1', $this->dataPrefix));
        $stmt->bind_param('i', $environmentClubId);
        $stmt->execute();
        $slug = trim((string) ($stmt->get_result()->fetch_assoc()['slug'] ?? ''));
        $stmt->close();
        if ($slug === '') {
            throw new ValidationException('club_not_found', 'Klubben finnes ikke i dette miljøet.', 404);
        }

        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sclubs` WHERE slug=? LIMIT 1', $this->hardwarePrefix));
        $stmt->bind_param('s', $slug);
        $stmt->execute();
        $id = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();
        if ($id <= 0) {
            throw new ValidationException('canonical_hardware_club_missing', 'Klubben mangler canonical PROD-utstyrsregister.', 409);
        }
        return $id;
    }

    /** @return array<string,int|null>|null */
    private function resolvePhysicalBoard(int $environmentClubId, int $kioskId): ?array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        if ($this->dataPrefix === $this->hardwarePrefix) {
            $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$skiosks` WHERE id=? AND club_id=? LIMIT 1', $this->hardwarePrefix));
            $stmt->bind_param('ii', $kioskId, $canonicalClubId);
            $stmt->execute();
            $exists = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            return $exists ? ['physical_kiosk_id'=>$kioskId,'runtime_kiosk_id'=>$kioskId,'canonical_club_id'=>$canonicalClubId] : null;
        }

        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,source_kiosk_id FROM `%1$skiosks` WHERE id=? AND club_id=? LIMIT 1',
            $this->dataPrefix
        ));
        $stmt->bind_param('ii', $kioskId, $environmentClubId);
        $stmt->execute();
        $runtime = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($runtime !== null) {
            $physicalId = (int) ($runtime['source_kiosk_id'] ?? 0);
            if ($physicalId <= 0) {
                throw new ValidationException(
                    'scolia_prod_hardware_required',
                    'Scolia kan bare konfigureres på en fysisk PROD-skive. TEST-skiver har ikke egne Scolia-innstillinger.',
                    409
                );
            }
            return ['physical_kiosk_id'=>$physicalId,'runtime_kiosk_id'=>(int) $runtime['id'],'canonical_club_id'=>$canonicalClubId];
        }

        // Admin/dashboard callers may explicitly refer to the physical id even in TEST.
        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$skiosks` WHERE id=? AND club_id=? LIMIT 1', $this->hardwarePrefix));
        $stmt->bind_param('ii', $kioskId, $canonicalClubId);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        if (!$exists) return null;
        return [
            'physical_kiosk_id'=>$kioskId,
            'runtime_kiosk_id'=>$this->runtimeKioskId($environmentClubId, $kioskId),
            'canonical_club_id'=>$canonicalClubId,
        ];
    }

    private function runtimeKioskId(int $environmentClubId, int $physicalId): ?int
    {
        if ($this->dataPrefix === $this->hardwarePrefix) return $physicalId;
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id FROM `%1$skiosks` WHERE club_id=? AND source_kiosk_id=? AND is_active=1 LIMIT 1',
            $this->dataPrefix
        ));
        $stmt->bind_param('ii', $environmentClubId, $physicalId);
        $stmt->execute();
        $id = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();
        return $id > 0 ? $id : null;
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
}
