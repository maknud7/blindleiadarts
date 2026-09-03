<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

/**
 * Physical board master data is shared across environments.
 *
 * In deployed TEST, dataPrefix points at bd_test_ while hardwarePrefix points at
 * bd_prod_. Board identity/configuration therefore comes from hardwarePrefix, while
 * pairing/runtime state stays in the active environment through a lightweight alias.
 */
final class EquipmentRepository
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
                throw new \RuntimeException('Invalid equipment table prefix.');
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

    /** @return array<int,array<string,mixed>> */
    public function listBoards(int $environmentClubId): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active,
                    pairing_token_hash,paired_device_name,paired_at,last_seen_at
             FROM `%1$skiosks` WHERE club_id=? AND is_active=1 ORDER BY board_number,id',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('i', $canonicalClubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            $physicalId = (int) $row['id'];
            $runtime = $this->runtimeBoard($environmentClubId, $physicalId);
            if ($this->dataPrefix !== $this->hardwarePrefix) {
                $row['pairing_token_hash'] = $runtime['pairing_token_hash'] ?? null;
                $row['paired_device_name'] = $runtime['paired_device_name'] ?? null;
                $row['paired_at'] = $runtime['paired_at'] ?? null;
                $row['last_seen_at'] = $runtime['last_seen_at'] ?? null;
            }
            $row['id'] = $physicalId;
            $row['physical_kiosk_id'] = $physicalId;
            $row['runtime_kiosk_id'] = $runtime !== null ? (int) $runtime['id'] : null;
            $row['environment_club_id'] = $environmentClubId;
            $row['canonical_club_id'] = $canonicalClubId;
            $row['is_paired'] = trim((string) ($row['pairing_token_hash'] ?? '')) !== '' ? 1 : 0;
            unset($row['pairing_token_hash']);
            $row = array_merge($row, $this->scope());
        }
        unset($row);
        return $rows;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function createBoard(int $environmentClubId, array $payload): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $club = $this->environmentClub($environmentClubId);
        $boardNumber = max(1, (int) ($payload['board_number'] ?? 0));
        $generatedCode = $this->generateKioskCode((string) ($club['slug'] ?? $club['name'] ?? 'club'), $boardNumber);
        $code = trim((string) ($payload['code'] ?? $generatedCode));
        $name = trim((string) ($payload['name'] ?? sprintf('Skive %d', $boardNumber)));
        $sponsorLabel = $this->nullableString($payload['sponsor_label'] ?? null);
        $sponsorLogoUrl = $this->nullableString($payload['sponsor_logo_url'] ?? null);
        $scoringMode = $this->normalizeScoringMode($payload['scoring_mode'] ?? null);

        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$skiosks`
             (club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,pairing_token_hash,paired_device_name,paired_at,is_active)
             VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,1)',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('ississs', $canonicalClubId, $code, $name, $boardNumber, $sponsorLabel, $sponsorLogoUrl, $scoringMode);
        $stmt->execute();
        $physicalId = (int) $stmt->insert_id;
        $stmt->close();

        return $this->findBoard($environmentClubId, $physicalId) ?? [];
    }

    /** @param array<string,mixed> $payload @return array<string,mixed>|null */
    public function updateBoard(int $environmentClubId, int $physicalId, array $payload): ?array
    {
        $existing = $this->findBoard($environmentClubId, $physicalId);
        if ($existing === null) return null;

        $canonicalClubId = (int) $existing['canonical_club_id'];
        $code = trim((string) ($payload['code'] ?? $existing['code']));
        $name = trim((string) ($payload['name'] ?? $existing['name']));
        $boardNumber = array_key_exists('board_number', $payload) ? max(1, (int) $payload['board_number']) : (int) $existing['board_number'];
        $sponsorLabel = array_key_exists('sponsor_label', $payload) ? $this->nullableString($payload['sponsor_label']) : $this->nullableString($existing['sponsor_label'] ?? null);
        $sponsorLogoUrl = array_key_exists('sponsor_logo_url', $payload) ? $this->nullableString($payload['sponsor_logo_url']) : $this->nullableString($existing['sponsor_logo_url'] ?? null);
        $scoringMode = $this->normalizeScoringMode($payload['scoring_mode'] ?? $existing['scoring_mode'] ?? null);
        $isActive = array_key_exists('is_active', $payload) ? ((int) $payload['is_active'] === 1 ? 1 : 0) : (int) $existing['is_active'];

        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$skiosks` SET code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,is_active=?
             WHERE id=? AND club_id=?',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('ssisssiii', $code, $name, $boardNumber, $sponsorLabel, $sponsorLogoUrl, $scoringMode, $isActive, $physicalId, $canonicalClubId);
        $stmt->execute();
        $stmt->close();

        // Keep an already-created TEST alias aligned with physical identity. It remains
        // manual runtime so editing PROD Scolia settings cannot accidentally route the
        // real Scolia service into TEST.
        if ($this->dataPrefix !== $this->hardwarePrefix) {
            $runtime = $this->runtimeBoard($environmentClubId, $physicalId);
            if ($runtime !== null) {
                $runtimeId = (int) $runtime['id'];
                $runtimeScoring = 'manual';
                $stmt = $this->connection->prepare(sprintf(
                    'UPDATE `%1$skiosks` SET name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,is_active=? WHERE id=?',
                    $this->dataPrefix
                ));
                $stmt->bind_param('sisssii', $name, $boardNumber, $sponsorLabel, $sponsorLogoUrl, $runtimeScoring, $isActive, $runtimeId);
                $stmt->execute();
                $stmt->close();
            }
        }

        return $this->findBoard($environmentClubId, $physicalId);
    }

    /** @return array<string,mixed>|null */
    public function resetPairing(int $environmentClubId, int $physicalId): ?array
    {
        $board = $this->findBoard($environmentClubId, $physicalId);
        if ($board === null) return null;
        $runtimeId = $this->runtimeKioskId($environmentClubId, $physicalId);
        if ($runtimeId === null) return $board;

        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$skiosks` SET pairing_token_hash=NULL,paired_device_name=NULL,paired_at=NULL,last_seen_at=NULL WHERE id=?',
            $this->dataPrefix
        ));
        $stmt->bind_param('i', $runtimeId);
        $stmt->execute();
        $stmt->close();
        return $this->findBoard($environmentClubId, $physicalId);
    }

    /**
     * Ensure that a physical board has a runtime row in the active environment.
     * Returns the runtime kiosk id used by pairing/matches.
     */
    public function ensureRuntimeAlias(int $environmentClubId, int $physicalId): int
    {
        $board = $this->findBoard($environmentClubId, $physicalId);
        if ($board === null) {
            throw new ValidationException('board_not_found', 'Skiva ble ikke funnet i canonical PROD-utstyrsregister.', 404);
        }
        if ($this->dataPrefix === $this->hardwarePrefix) return $physicalId;

        $existing = $this->runtimeBoard($environmentClubId, $physicalId);
        if ($existing !== null) return (int) $existing['id'];

        $boardNumber = (int) $board['board_number'];
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,source_kiosk_id FROM `%1$skiosks` WHERE club_id=? AND board_number=? LIMIT 1 FOR UPDATE',
            $this->dataPrefix
        ));
        $stmt->bind_param('ii', $environmentClubId, $boardNumber);
        $stmt->execute();
        $conflict = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        $aliasCode = 'TEST-' . strtoupper(substr(hash('sha256', (string) $board['code']), 0, 20));
        $name = (string) $board['name'];
        $sponsorLabel = $this->nullableString($board['sponsor_label'] ?? null);
        $sponsorLogo = $this->nullableString($board['sponsor_logo_url'] ?? null);
        $runtimeScoring = 'manual';

        if ($conflict !== null) {
            $runtimeId = (int) $conflict['id'];
            $stmt = $this->connection->prepare(sprintf(
                'UPDATE `%1$skiosks` SET source_kiosk_id=?,code=?,name=?,board_number=?,sponsor_label=?,sponsor_logo_url=?,scoring_mode=?,is_active=1 WHERE id=?',
                $this->dataPrefix
            ));
            $stmt->bind_param('ississsi', $physicalId, $aliasCode, $name, $boardNumber, $sponsorLabel, $sponsorLogo, $runtimeScoring, $runtimeId);
            $stmt->execute();
            $stmt->close();
            return $runtimeId;
        }

        $stmt = $this->connection->prepare(sprintf(
            'INSERT INTO `%1$skiosks`
             (source_kiosk_id,club_id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active)
             VALUES (?,?,?,?,?,?,?,?,1)',
            $this->dataPrefix
        ));
        $stmt->bind_param('iississs', $physicalId, $environmentClubId, $aliasCode, $name, $boardNumber, $sponsorLabel, $sponsorLogo, $runtimeScoring);
        $stmt->execute();
        $runtimeId = (int) $stmt->insert_id;
        $stmt->close();
        return $runtimeId;
    }

    public function deleteBoard(int $environmentClubId, int $physicalId): bool
    {
        $board = $this->findBoard($environmentClubId, $physicalId);
        if ($board === null) return false;

        $matchCount = $this->countBoardMatches($environmentClubId, $physicalId);
        if ($matchCount > 0) {
            throw new ValidationException(
                'board_has_match_history',
                sprintf('Skiva er brukt i %d kamp%s og kan ikke slettes. Deaktiver den i stedet.', $matchCount, $matchCount === 1 ? '' : 'er'),
                409
            );
        }

        $canonicalClubId = (int) $board['canonical_club_id'];
        $this->connection->begin_transaction();
        try {
            // Remove runtime alias first when TEST and PROD are split.
            if ($this->dataPrefix !== $this->hardwarePrefix) {
                $runtimeId = $this->runtimeKioskId($environmentClubId, $physicalId);
                if ($runtimeId !== null) {
                    $this->deleteRuntimeReferences($runtimeId);
                    $stmt = $this->connection->prepare(sprintf('DELETE FROM `%1$skiosks` WHERE id=? AND club_id=?', $this->dataPrefix));
                    $stmt->bind_param('ii', $runtimeId, $environmentClubId);
                    $stmt->execute();
                    $stmt->close();
                }
            }

            // Canonical PROD references are safe to remove only after history check.
            $this->deletePhysicalReferences($physicalId);
            $stmt = $this->connection->prepare(sprintf('DELETE FROM `%1$skiosks` WHERE id=? AND club_id=?', $this->hardwarePrefix));
            $stmt->bind_param('ii', $physicalId, $canonicalClubId);
            $stmt->execute();
            $deleted = $stmt->affected_rows > 0;
            $stmt->close();
            $this->connection->commit();
            return $deleted;
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    public function deleteScreen(int $clubId, int $screenId): bool
    {
        $sql = sprintf('DELETE FROM `%1$sscreen_devices` WHERE id=? AND club_id=?', $this->dataPrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $screenId, $clubId);
        $statement->execute();
        $deleted = $statement->affected_rows > 0;
        $statement->close();
        return $deleted;
    }

    /** @return array<string,mixed>|null */
    private function findBoard(int $environmentClubId, int $physicalId): ?array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active,
                    pairing_token_hash,paired_device_name,paired_at,last_seen_at
             FROM `%1$skiosks` WHERE id=? AND club_id=? LIMIT 1',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('ii', $physicalId, $canonicalClubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;

        $runtime = $this->runtimeBoard($environmentClubId, $physicalId);
        if ($this->dataPrefix !== $this->hardwarePrefix) {
            $row['pairing_token_hash'] = $runtime['pairing_token_hash'] ?? null;
            $row['paired_device_name'] = $runtime['paired_device_name'] ?? null;
            $row['paired_at'] = $runtime['paired_at'] ?? null;
            $row['last_seen_at'] = $runtime['last_seen_at'] ?? null;
        }
        $row['id'] = $physicalId;
        $row['physical_kiosk_id'] = $physicalId;
        $row['runtime_kiosk_id'] = $runtime !== null ? (int) $runtime['id'] : null;
        $row['environment_club_id'] = $environmentClubId;
        $row['canonical_club_id'] = $canonicalClubId;
        $row['is_paired'] = trim((string) ($row['pairing_token_hash'] ?? '')) !== '' ? 1 : 0;
        unset($row['pairing_token_hash']);
        return array_merge($row, $this->scope());
    }

    /** @return array<string,mixed>|null */
    private function runtimeBoard(int $environmentClubId, int $physicalId): ?array
    {
        if ($this->dataPrefix === $this->hardwarePrefix) {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT id,pairing_token_hash,paired_device_name,paired_at,last_seen_at FROM `%1$skiosks` WHERE id=? LIMIT 1',
                $this->dataPrefix
            ));
            $stmt->bind_param('i', $physicalId);
        } else {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT id,pairing_token_hash,paired_device_name,paired_at,last_seen_at FROM `%1$skiosks`
                 WHERE club_id=? AND source_kiosk_id=? AND is_active=1 LIMIT 1',
                $this->dataPrefix
            ));
            $stmt->bind_param('ii', $environmentClubId, $physicalId);
        }
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function runtimeKioskId(int $environmentClubId, int $physicalId): ?int
    {
        $runtime = $this->runtimeBoard($environmentClubId, $physicalId);
        return $runtime !== null ? (int) $runtime['id'] : null;
    }

    private function canonicalClubId(int $environmentClubId): int
    {
        if ($this->dataPrefix === $this->hardwarePrefix) return $environmentClubId;
        $club = $this->environmentClub($environmentClubId);
        $slug = trim((string) ($club['slug'] ?? ''));
        if ($slug === '') throw new ValidationException('club_not_found', 'Klubben finnes ikke i dette miljøet.', 404);

        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sclubs` WHERE slug=? LIMIT 1', $this->hardwarePrefix));
        $stmt->bind_param('s', $slug);
        $stmt->execute();
        $id = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();
        if ($id <= 0) throw new ValidationException('canonical_hardware_club_missing', 'Klubben mangler canonical PROD-utstyrsregister.', 409);
        return $id;
    }

    /** @return array<string,mixed> */
    private function environmentClub(int $environmentClubId): array
    {
        $stmt = $this->connection->prepare(sprintf('SELECT id,name,slug FROM `%1$sclubs` WHERE id=? LIMIT 1', $this->dataPrefix));
        $stmt->bind_param('i', $environmentClubId);
        $stmt->execute();
        $club = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($club === null) throw new ValidationException('club_not_found', 'Klubben finnes ikke i dette miljøet.', 404);
        return $club;
    }

    private function countBoardMatches(int $environmentClubId, int $physicalId): int
    {
        $count = 0;
        $stmt = $this->connection->prepare(sprintf('SELECT COUNT(*) AS c FROM `%1$smatches` WHERE kiosk_id=?', $this->hardwarePrefix));
        $stmt->bind_param('i', $physicalId);
        $stmt->execute();
        $count += (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
        $stmt->close();

        if ($this->dataPrefix !== $this->hardwarePrefix) {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT COUNT(*) AS c FROM `%1$smatches` m INNER JOIN `%1$skiosks` k ON k.id=m.kiosk_id
                 WHERE k.club_id=? AND (k.source_kiosk_id=? OR k.id=?)',
                $this->dataPrefix
            ));
            $stmt->bind_param('iii', $environmentClubId, $physicalId, $physicalId);
            $stmt->execute();
            $count += (int) ($stmt->get_result()->fetch_assoc()['c'] ?? 0);
            $stmt->close();
        }
        return $count;
    }

    private function deleteRuntimeReferences(int $runtimeId): void
    {
        foreach (['tournament_board_reservations','tournament_kiosks','kiosk_sessions'] as $table) {
            $this->deleteWhere($this->dataPrefix, $table, 'kiosk_id', $runtimeId);
        }
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$skiosk_pairing_requests` SET approved_kiosk_id=NULL WHERE approved_kiosk_id=?',
            $this->dataPrefix
        ));
        $stmt->bind_param('i', $runtimeId);
        $stmt->execute();
        $stmt->close();
    }

    private function deletePhysicalReferences(int $physicalId): void
    {
        foreach (['tournament_board_reservations','tournament_kiosks','kiosk_sessions'] as $table) {
            $this->deleteWhere($this->hardwarePrefix, $table, 'kiosk_id', $physicalId);
        }
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$skiosk_pairing_requests` SET approved_kiosk_id=NULL WHERE approved_kiosk_id=?',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('i', $physicalId);
        $stmt->execute();
        $stmt->close();
    }

    private function deleteWhere(string $prefix, string $table, string $column, int $id): void
    {
        $stmt = $this->connection->prepare(sprintf('DELETE FROM `%1$s%2$s` WHERE `%3$s`=?', $prefix, $table, $column));
        $stmt->bind_param('i', $id);
        $stmt->execute();
        $stmt->close();
    }

    private function nullableString(mixed $value): ?string
    {
        if ($value === null) return null;
        $value = trim((string) $value);
        return $value === '' ? null : $value;
    }

    private function normalizeScoringMode(mixed $value): string
    {
        $mode = strtolower(trim((string) ($value ?? 'manual')));
        return $mode === 'scolia' ? 'scolia' : 'manual';
    }

    private function generateKioskCode(string $clubKey, int $boardNumber): string
    {
        $base = strtoupper(preg_replace('/[^A-Za-z0-9]+/', '-', $clubKey) ?? 'CLUB');
        $base = trim($base, '-');
        if ($base === '') $base = 'CLUB';
        $base = substr($base, 0, 48);
        $candidate = sprintf('%s-B%02d', $base, $boardNumber);
        $counter = 1;
        while ($this->kioskCodeExists($candidate)) {
            $counter++;
            $candidate = sprintf('%s-B%02d-%d', $base, $boardNumber, $counter);
        }
        return $candidate;
    }

    private function kioskCodeExists(string $code): bool
    {
        $stmt = $this->connection->prepare(sprintf('SELECT 1 FROM `%1$skiosks` WHERE code=? LIMIT 1', $this->hardwarePrefix));
        $stmt->bind_param('s', $code);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    }
}
