<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class ExternalReferenceRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    public function findInternalId(string $externalSystem, string $externalEntityType, string $externalId): ?int
    {
        $sql = sprintf(
            'SELECT internal_id
             FROM `%1$sexternal_references`
             WHERE external_system = ?
               AND external_entity_type = ?
               AND external_id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('sss', $externalSystem, $externalEntityType, $externalId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row !== null ? (int) $row['internal_id'] : null;
    }

    public function upsert(
        string $externalSystem,
        string $externalEntityType,
        string $externalId,
        string $internalEntityType,
        int $internalId,
        string $syncState = 'synced'
    ): void {
        $existingInternalId = $this->findInternalId($externalSystem, $externalEntityType, $externalId);

        if ($existingInternalId !== null) {
            $sql = sprintf(
                'UPDATE `%1$sexternal_references`
                 SET internal_id = ?, internal_entity_type = ?, sync_state = ?, last_synced_at = NOW()
                 WHERE external_system = ?
                   AND external_entity_type = ?
                   AND external_id = ?',
                $this->tablePrefix
            );

            $statement = $this->connection->prepare($sql);
            $statement->bind_param(
                'isssss',
                $internalId,
                $internalEntityType,
                $syncState,
                $externalSystem,
                $externalEntityType,
                $externalId
            );
            $statement->execute();
            $statement->close();
            return;
        }

        $sql = sprintf(
            'INSERT INTO `%1$sexternal_references`
             (
                external_system,
                external_entity_type,
                external_id,
                internal_entity_type,
                internal_id,
                sync_state,
                last_synced_at
             )
             VALUES (?, ?, ?, ?, ?, ?, NOW())',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param(
            'ssssis',
            $externalSystem,
            $externalEntityType,
            $externalId,
            $internalEntityType,
            $internalId,
            $syncState
        );
        $statement->execute();
        $statement->close();
    }
}
