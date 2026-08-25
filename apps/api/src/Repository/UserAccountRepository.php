<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use InvalidArgumentException;
use mysqli;
use mysqli_sql_exception;
use RuntimeException;

final class UserAccountRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $identityPrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->identityPrefix = $database->identityTablePrefix();

        foreach ([$this->dataPrefix, $this->identityPrefix] as $prefix) {
            if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
                throw new RuntimeException('Invalid database table prefix.');
            }
        }
    }

    /** @return array<string, mixed>|null */
    public function findByUsername(string $login): ?array
    {
        $login = trim($login);
        $sql = $this->identitySelectSql(
            'WHERE LOWER(ua.username) = LOWER(?) OR LOWER(ua.email) = LOWER(?) LIMIT 1',
            false
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
        $sql = $this->identitySelectSql(
            'WHERE s.session_token_hash = ?
               AND s.revoked_at IS NULL
               AND ua.is_active = 1
               AND ua.account_status = "active"
             LIMIT 1',
            true
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
            $sessions = $this->identityPrefix . 'auth_sessions';
            $touch = $this->connection->prepare("UPDATE `{$sessions}` SET last_used_at = NOW() WHERE id = ?");
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

        $users = $this->identityPrefix . 'user_accounts';
        $statement = $this->connection->prepare("UPDATE `{$users}` SET email = ? WHERE id = ?");
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
        $sessions = $this->identityPrefix . 'auth_sessions';
        $users = $this->identityPrefix . 'user_accounts';

        $statement = $this->connection->prepare(
            "INSERT INTO `{$sessions}` (user_account_id, session_token_hash, expires_at, last_used_at)
             VALUES (?, ?, ?, NOW())"
        );
        $statement->bind_param('iss', $userAccountId, $hash, $expiresAt);
        $statement->execute();
        $statement->close();

        $touch = $this->connection->prepare("UPDATE `{$users}` SET last_login_at = NOW() WHERE id = ?");
        $touch->bind_param('i', $userAccountId);
        $touch->execute();
        $touch->close();

        return ['token' => $token, 'expires_at' => $expiresAt];
    }

    private function identitySelectSql(string $whereSql, bool $withSession): string
    {
        $users = $this->identityPrefix . 'user_accounts';
        $globalRoles = $this->identityPrefix . 'global_user_roles';
        $clubRoles = $this->identityPrefix . 'club_user_roles';
        $identityPlayers = $this->identityPrefix . 'players';
        $identityClubs = $this->identityPrefix . 'clubs';
        $localPlayers = $this->dataPrefix . 'players';
        $localClubs = $this->dataPrefix . 'clubs';
        $sessions = $this->identityPrefix . 'auth_sessions';

        if ($this->identityPrefix === $this->dataPrefix) {
            $adminClubIdsSql = "(SELECT GROUP_CONCAT(cur.club_id ORDER BY cur.club_id SEPARATOR ',')
                   FROM `{$clubRoles}` cur
                  WHERE cur.user_account_id = ua.id AND cur.role = 'club_admin')";
        } else {
            // Club permissions are shared from production, but test club IDs are local.
            // Map the permission by canonical club slug so the caller always receives
            // IDs belonging to the current environment.
            $adminClubIdsSql = "(SELECT GROUP_CONCAT(lc.id ORDER BY lc.id SEPARATOR ',')
                   FROM `{$clubRoles}` cur
                   INNER JOIN `{$identityClubs}` ic ON ic.id = cur.club_id
                   INNER JOIN `{$localClubs}` lc ON lc.slug = ic.slug
                  WHERE cur.user_account_id = ua.id AND cur.role = 'club_admin')";
        }

        $sessionSelect = $withSession
            ? ', s.id AS session_id, s.expires_at, s.revoked_at'
            : '';
        $sessionJoin = $withSession
            ? "INNER JOIN `{$sessions}` s ON s.user_account_id = ua.id"
            : '';

        return "SELECT
                ua.id,
                ua.username,
                ua.email,
                " . ($withSession ? '' : 'ua.password_hash,') . "
                ua.display_name,
                ua.account_status,
                ua.member_id AS account_member_id,
                ua.player_id AS account_player_id,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM `{$globalRoles}` gur
                        WHERE gur.user_account_id = ua.id AND gur.role = 'super_admin'
                    ) THEN 'super_admin'
                    WHEN EXISTS (
                        SELECT 1 FROM `{$clubRoles}` cur0
                        WHERE cur0.user_account_id = ua.id AND cur0.role = 'club_admin'
                    ) THEN 'club_admin'
                    ELSE 'player'
                END AS role,
                ua.role AS legacy_role,
                ua.is_active,
                ua.email AS contact_email,
                ua.contact_phone,
                p.id AS player_id,
                p.display_name AS player_display_name,
                p.club_id AS player_club_id,
                p.member_id AS player_member_id,
                COALESCE(ua.member_id, ip.member_id, p.member_id) AS member_id,
                p.member_link_source AS player_member_link_source,
                {$adminClubIdsSql} AS admin_club_ids,
                (SELECT GROUP_CONCAT(gur.role ORDER BY gur.role SEPARATOR ',')
                   FROM `{$globalRoles}` gur
                  WHERE gur.user_account_id = ua.id) AS global_roles
                {$sessionSelect}
             FROM `{$users}` ua
             {$sessionJoin}
             LEFT JOIN `{$identityPlayers}` ip ON ip.id = ua.player_id
             LEFT JOIN `{$localPlayers}` p ON p.id = (
                SELECT MIN(p2.id)
                FROM `{$localPlayers}` p2
                WHERE p2.member_id = COALESCE(ua.member_id, ip.member_id)
             )
             {$whereSql}";
    }
}