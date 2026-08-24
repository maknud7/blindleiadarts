<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use InvalidArgumentException;
use mysqli;
use mysqli_sql_exception;

final class UserAccountRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string, mixed>|null */
    public function findByUsername(string $login): ?array
    {
        $login = trim($login);
        $sql = sprintf(
            'SELECT
                ua.id,
                ua.username,
                ua.email,
                ua.password_hash,
                ua.display_name,
                ua.account_status,
                ua.member_id AS account_member_id,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM `%1$sglobal_user_roles` gur
                        WHERE gur.user_account_id = ua.id AND gur.role = "super_admin"
                    ) THEN "super_admin"
                    WHEN EXISTS (
                        SELECT 1 FROM `%1$sclub_user_roles` cur0
                        WHERE cur0.user_account_id = ua.id AND cur0.role = "club_admin"
                    ) THEN "club_admin"
                    ELSE "player"
                END AS role,
                ua.role AS legacy_role,
                ua.is_active,
                ua.email AS contact_email,
                ua.contact_phone,
                ua.player_id,
                p.display_name AS player_display_name,
                p.club_id AS player_club_id,
                p.member_id AS player_member_id,
                COALESCE(ua.member_id, p.member_id) AS member_id,
                p.member_link_source AS player_member_link_source,
                (SELECT GROUP_CONCAT(cur.club_id ORDER BY cur.club_id SEPARATOR ",")
                   FROM `%1$sclub_user_roles` cur
                  WHERE cur.user_account_id = ua.id AND cur.role = "club_admin") AS admin_club_ids,
                (SELECT GROUP_CONCAT(gur.role ORDER BY gur.role SEPARATOR ",")
                   FROM `%1$sglobal_user_roles` gur
                  WHERE gur.user_account_id = ua.id) AS global_roles
             FROM `%1$suser_accounts` ua
             LEFT JOIN `%1$splayers` p ON p.id = ua.player_id
             WHERE LOWER(ua.username) = LOWER(?) OR LOWER(ua.email) = LOWER(?)
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ss', $login, $login);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        return $row;
    }

    /** @return array<string, mixed>|null */
    public function findBySessionToken(string $token): ?array
    {
        $hash = hash('sha256', $token);
        $sql = sprintf(
            'SELECT
                ua.id,
                ua.username,
                ua.email,
                ua.display_name,
                ua.account_status,
                ua.member_id AS account_member_id,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM `%1$sglobal_user_roles` gur
                        WHERE gur.user_account_id = ua.id AND gur.role = "super_admin"
                    ) THEN "super_admin"
                    WHEN EXISTS (
                        SELECT 1 FROM `%1$sclub_user_roles` cur0
                        WHERE cur0.user_account_id = ua.id AND cur0.role = "club_admin"
                    ) THEN "club_admin"
                    ELSE "player"
                END AS role,
                ua.role AS legacy_role,
                ua.is_active,
                ua.email AS contact_email,
                ua.contact_phone,
                ua.player_id,
                p.club_id AS player_club_id,
                p.display_name AS player_display_name,
                p.member_id AS player_member_id,
                COALESCE(ua.member_id, p.member_id) AS member_id,
                p.member_link_source AS player_member_link_source,
                (SELECT GROUP_CONCAT(cur.club_id ORDER BY cur.club_id SEPARATOR ",")
                   FROM `%1$sclub_user_roles` cur
                  WHERE cur.user_account_id = ua.id AND cur.role = "club_admin") AS admin_club_ids,
                (SELECT GROUP_CONCAT(gur.role ORDER BY gur.role SEPARATOR ",")
                   FROM `%1$sglobal_user_roles` gur
                  WHERE gur.user_account_id = ua.id) AS global_roles,
                s.id AS session_id,
                s.expires_at,
                s.revoked_at
             FROM `%1$sauth_sessions` s
             INNER JOIN `%1$suser_accounts` ua ON ua.id = s.user_account_id
             LEFT JOIN `%1$splayers` p ON p.id = ua.player_id
             WHERE s.session_token_hash = ?
               AND s.revoked_at IS NULL
               AND ua.is_active = 1
               AND ua.account_status = "active"
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $hash);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
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

    public function updateEmail(int $userAccountId, string $email): void
    {
        $email = mb_strtolower(trim($email), 'UTF-8');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new InvalidArgumentException('Ugyldig e-postadresse.');
        }

        $sql = sprintf('UPDATE `%1$suser_accounts` SET email = ? WHERE id = ?', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        try {
            $statement->bind_param('si', $email, $userAccountId);
            $statement->execute();
        } catch (mysqli_sql_exception $error) {
            if ((int) $error->getCode() === 1062) {
                throw new InvalidArgumentException('E-postadressen er allerede i bruk av en annen konto.', 0, $error);
            }
            throw $error;
        } finally {
            $statement->close();
        }
    }

    /** @return array{token:string,expires_at:string} */
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

        return ['token' => $token, 'expires_at' => $expiresAt];
    }
}
