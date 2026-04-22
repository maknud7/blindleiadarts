<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;

final class ConnectorAuthorizationRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function storeOAuthAuthorization(
        string $providerKey,
        ?string $externalSubjectId,
        ?string $externalSubjectName,
        string $accessToken,
        ?string $refreshToken,
        ?string $tokenType,
        ?string $scope,
        ?DateTimeImmutable $expiresAt,
        array $payload
    ): int {
        $sql = sprintf(
            'INSERT INTO `%1$sconnector_authorizations`
             (
                provider_key,
                authorization_type,
                external_subject_id,
                external_subject_name,
                access_token,
                refresh_token,
                token_type,
                scope,
                expires_at,
                payload_json
             )
             VALUES (?, "oauth", ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $expiresAtValue = $expiresAt?->format('Y-m-d H:i:s');
        $payloadJson = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $statement->bind_param(
            'sssssssss',
            $providerKey,
            $externalSubjectId,
            $externalSubjectName,
            $accessToken,
            $refreshToken,
            $tokenType,
            $scope,
            $expiresAtValue,
            $payloadJson
        );
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $id;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listByProvider(string $providerKey): array
    {
        $sql = sprintf(
            'SELECT id, provider_key, authorization_type, external_subject_id, external_subject_name, token_type, scope, expires_at, created_at, updated_at
             FROM `%1$sconnector_authorizations`
             WHERE provider_key = ?
             ORDER BY id DESC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $providerKey);
        $statement->execute();
        $result = $statement->get_result();
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findById(int $id): ?array
    {
        $sql = sprintf(
            'SELECT *
             FROM `%1$sconnector_authorizations`
             WHERE id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $id);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        if ($row !== null && is_string($row['payload_json'] ?? null) && $row['payload_json'] !== '') {
            $row['payload_json'] = json_decode($row['payload_json'], true);
        }

        return $row;
    }
}
