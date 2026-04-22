<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;

final class UserAccountRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findByUsername(string $username): ?array
    {
        $sql = sprintf(
            'SELECT
                ua.id,
                ua.username,
                ua.password_hash,
                ua.display_name,
                ua.role,
                ua.is_active,
                mp.contact_email,
                mp.contact_phone,
                mp.player_id,
                p.display_name AS player_display_name,
                p.club_id AS player_club_id
             FROM `%1$suser_accounts` ua
             LEFT JOIN `%1$smember_profiles` mp ON mp.user_account_id = ua.id
             LEFT JOIN `%1$splayers` p ON p.id = mp.player_id
             WHERE ua.username = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $username);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findBySessionToken(string $token): ?array
    {
        $hash = hash('sha256', $token);
        $sql = sprintf(
            'SELECT
                ua.id,
                ua.username,
                ua.display_name,
                ua.role,
                ua.is_active,
                mp.contact_email,
                mp.contact_phone,
                mp.player_id,
                p.club_id AS player_club_id,
                p.display_name AS player_display_name,
                s.id AS session_id,
                s.expires_at,
                s.revoked_at
             FROM `%1$sauth_sessions` s
             INNER JOIN `%1$suser_accounts` ua ON ua.id = s.user_account_id
             LEFT JOIN `%1$smember_profiles` mp ON mp.user_account_id = ua.id
             LEFT JOIN `%1$splayers` p ON p.id = mp.player_id
             WHERE s.session_token_hash = ?
               AND s.revoked_at IS NULL
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $hash);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        if ($row === null) {
            return null;
        }

        if (isset($row['expires_at']) && is_string($row['expires_at']) && strtotime($row['expires_at']) < time()) {
            return null;
        }

        $sessionId = (int) ($row['session_id'] ?? 0);
        if ($sessionId > 0) {
            $touchSql = sprintf('UPDATE `%1$sauth_sessions` SET last_used_at = NOW() WHERE id = ?', $this->tablePrefix);
            $touch = $this->connection->prepare($touchSql);
            $touch->bind_param('i', $sessionId);
            $touch->execute();
            $touch->close();
        }

        return $row;
    }

    /**
     * @return array{token:string,expires_at:string}
     */
    public function createSession(int $userAccountId): array
    {
        $token = bin2hex(random_bytes(32));
        $hash = hash('sha256', $token);
        $expiresAt = (new DateTimeImmutable('+7 days'))->format('Y-m-d H:i:s');

        $sql = sprintf(
            'INSERT INTO `%1$sauth_sessions` (user_account_id, session_token_hash, expires_at, last_used_at)
             VALUES (?, ?, ?, NOW())',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iss', $userAccountId, $hash, $expiresAt);
        $statement->execute();
        $statement->close();

        $touchSql = sprintf('UPDATE `%1$suser_accounts` SET last_login_at = NOW() WHERE id = ?', $this->tablePrefix);
        $touch = $this->connection->prepare($touchSql);
        $touch->bind_param('i', $userAccountId);
        $touch->execute();
        $touch->close();

        return [
            'token' => $token,
            'expires_at' => $expiresAt,
        ];
    }
}
