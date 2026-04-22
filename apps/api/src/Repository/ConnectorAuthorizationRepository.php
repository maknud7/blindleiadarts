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
}
