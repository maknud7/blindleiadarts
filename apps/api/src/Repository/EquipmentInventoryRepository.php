<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

/**
 * Admin inventory for physical boards.
 *
 * Runtime consumers use EquipmentRepository::listBoards(), which intentionally
 * returns active boards only. This inventory adds inactive canonical boards for
 * administration without changing kiosk/pairing semantics.
 */
final class EquipmentInventoryRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $hardwarePrefix;
    private EquipmentRepository $equipment;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->hardwarePrefix = $database->hardwareTablePrefix();
        foreach ([$this->dataPrefix, $this->hardwarePrefix] as $prefix) {
            if (preg_match('/^[A-Za-z0-9_]+$/', $prefix) !== 1) {
                throw new \RuntimeException('Invalid equipment inventory table prefix.');
            }
        }
        $this->equipment = new EquipmentRepository($database);
    }

    /** @return array<int,array<string,mixed>> */
    public function listBoards(int $environmentClubId): array
    {
        $canonicalClubId = $this->canonicalClubId($environmentClubId);
        $activeById = [];
        foreach ($this->equipment->listBoards($environmentClubId) as $board) {
            $activeById[(int) ($board['id'] ?? 0)] = $board;
        }

        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,code,name,board_number,sponsor_label,sponsor_logo_url,scoring_mode,is_active
             FROM `%1$skiosks` WHERE club_id=? ORDER BY is_active DESC,board_number,id',
            $this->hardwarePrefix
        ));
        $stmt->bind_param('i', $canonicalClubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $scope = $this->equipment->scope();
        foreach ($rows as &$row) {
            $physicalId = (int) $row['id'];
            if (isset($activeById[$physicalId])) {
                $row = $activeById[$physicalId];
                continue;
            }

            $row['id'] = $physicalId;
            $row['physical_kiosk_id'] = $physicalId;
            $row['runtime_kiosk_id'] = null;
            $row['environment_club_id'] = $environmentClubId;
            $row['canonical_club_id'] = $canonicalClubId;
            $row['is_paired'] = 0;
            $row['paired_device_name'] = null;
            $row['paired_at'] = null;
            $row['last_seen_at'] = null;
            $row = array_merge($row, $scope);
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
        if ($slug === '') throw new ValidationException('club_not_found', 'Klubben finnes ikke i dette miljøet.', 404);

        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sclubs` WHERE slug=? LIMIT 1', $this->hardwarePrefix));
        $stmt->bind_param('s', $slug);
        $stmt->execute();
        $canonicalClubId = (int) ($stmt->get_result()->fetch_assoc()['id'] ?? 0);
        $stmt->close();
        if ($canonicalClubId <= 0) {
            throw new ValidationException('canonical_hardware_club_missing', 'Klubben mangler canonical PROD-utstyrsregister.', 409);
        }
        return $canonicalClubId;
    }
}
