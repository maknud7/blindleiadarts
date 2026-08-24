<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use InvalidArgumentException;
use mysqli;
use mysqli_sql_exception;
use RuntimeException;

final class MemberOnboardingRepository
{
    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
    }

    /** @return array{items:list<array<string,mixed>>,summary:array<string,int>} */
    public function listMembers(int $clubId): array
    {
        if ($clubId <= 0) {
            throw new InvalidArgumentException('Ugyldig klubb.');
        }

        $players = $this->prefix . 'players';
        $users = $this->prefix . 'user_accounts';
        $invitations = $this->prefix . 'user_onboarding_invitations';

        $sql = "SELECT
                    m.id AS member_id,
                    m.navn AS member_name,
                    p.id AS player_id,
                    p.display_name AS player_name,
                    ua.id AS account_id,
                    ua.email,
                    ua.account_status,
                    ua.invited_at,
                    ua.claimed_at,
                    ua.last_login_at,
                    (SELECT MAX(i.expires_at)
                       FROM `{$invitations}` i
                      WHERE i.user_account_id=ua.id
                        AND i.used_at IS NULL
                        AND i.revoked_at IS NULL
                        AND i.expires_at > NOW()) AS invite_expires_at
                FROM `medlemmer` m
                LEFT JOIN (
                    SELECT p0.id, p0.member_id, p0.display_name
                    FROM `{$players}` p0
                    INNER JOIN (
                        SELECT member_id, MIN(id) AS id
                        FROM `{$players}`
                        WHERE club_id=? AND member_id IS NOT NULL
                        GROUP BY member_id
                    ) px ON px.id=p0.id
                ) p ON p.member_id=m.id
                LEFT JOIN `{$users}` ua ON ua.member_id=m.id
                ORDER BY m.navn ASC, m.id ASC";

        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $result = $stmt->get_result();

        $items = [];
        $summary = [
            'members' => 0,
            'with_player' => 0,
            'without_account' => 0,
            'unclaimed' => 0,
            'invited' => 0,
            'active' => 0,
            'disabled' => 0,
        ];

        while ($row = $result->fetch_assoc()) {
            $status = $row['account_id'] === null ? 'none' : (string) ($row['account_status'] ?? 'unclaimed');
            $summary['members']++;
            if ($row['player_id'] !== null) {
                $summary['with_player']++;
            }
            if ($status === 'none') {
                $summary['without_account']++;
            } elseif (isset($summary[$status])) {
                $summary[$status]++;
            }

            $items[] = [
                'member_id' => (int) $row['member_id'],
                'member_name' => (string) $row['member_name'],
                'player' => $row['player_id'] !== null ? [
                    'id' => (int) $row['player_id'],
                    'display_name' => (string) ($row['player_name'] ?? ''),
                ] : null,
                'account' => $row['account_id'] !== null ? [
                    'id' => (int) $row['account_id'],
                    'email' => $row['email'] !== null ? (string) $row['email'] : null,
                    'status' => $status,
                    'invited_at' => $row['invited_at'],
                    'claimed_at' => $row['claimed_at'],
                    'last_login_at' => $row['last_login_at'],
                    'invite_expires_at' => $row['invite_expires_at'],
                ] : null,
            ];
        }
        $result->free();
        $stmt->close();

        return ['items' => $items, 'summary' => $summary];
    }

    /**
     * @return array{token:string,expires_at:string,account:array<string,mixed>,member:array<string,mixed>}
     */
    public function createInvitation(int $clubId, int $memberId, int $createdByUserAccountId, ?string $email = null): array
    {
        if ($clubId <= 0 || $memberId <= 0 || $createdByUserAccountId <= 0) {
            throw new InvalidArgumentException('Ugyldig invitasjonsforespørsel.');
        }

        $email = $this->normalizeOptionalEmail($email);
        $users = $this->prefix . 'user_accounts';
        $players = $this->prefix . 'players';
        $sessions = $this->prefix . 'auth_sessions';
        $invitations = $this->prefix . 'user_onboarding_invitations';

        $this->connection->begin_transaction();
        try {
            $memberStmt = $this->connection->prepare('SELECT id, navn FROM `medlemmer` WHERE id=? LIMIT 1 FOR UPDATE');
            $memberStmt->bind_param('i', $memberId);
            $memberStmt->execute();
            $member = $memberStmt->get_result()->fetch_assoc() ?: null;
            $memberStmt->close();
            if ($member === null) {
                throw new InvalidArgumentException('Medlemmet finnes ikke.');
            }

            $playerStmt = $this->connection->prepare(
                "SELECT id, display_name FROM `{$players}` WHERE club_id=? AND member_id=? ORDER BY id ASC LIMIT 1"
            );
            $playerStmt->bind_param('ii', $clubId, $memberId);
            $playerStmt->execute();
            $player = $playerStmt->get_result()->fetch_assoc() ?: null;
            $playerStmt->close();
            $playerId = $player !== null ? (int) $player['id'] : null;

            $account = $this->findAccountForMemberOrPlayer($memberId, $playerId, true);
            if ($account !== null && (string) ($account['account_status'] ?? '') === 'active') {
                throw new InvalidArgumentException('Medlemmet har allerede en aktiv brukerkonto.');
            }

            if ($account === null) {
                $username = $this->nextInternalUsername($memberId);
                $displayName = trim((string) $member['navn']);
                $status = 'invited';
                $role = 'player';
                $isActive = 0;
                $insert = $this->connection->prepare(
                    "INSERT INTO `{$users}`
                        (username, email, password_hash, display_name, player_id, member_id, role, is_active, account_status, invited_at)
                     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NOW())"
                );
                $insert->bind_param('sssiiisis', $username, $email, $displayName, $playerId, $memberId, $role, $isActive, $status);
                $insert->execute();
                $accountId = (int) $insert->insert_id;
                $insert->close();
            } else {
                $accountId = (int) $account['id'];
                if ($email !== null) {
                    $this->assertEmailAvailable($email, $accountId);
                }
                $status = 'invited';
                $update = $this->connection->prepare(
                    "UPDATE `{$users}`
                     SET member_id=?,
                         player_id=COALESCE(player_id, ?),
                         email=COALESCE(?, email),
                         password_hash=NULL,
                         account_status=?,
                         is_active=0,
                         invited_at=NOW(),
                         claimed_at=NULL
                     WHERE id=?"
                );
                $update->bind_param('iissi', $memberId, $playerId, $email, $status, $accountId);
                $update->execute();
                $update->close();
            }

            $revoke = $this->connection->prepare(
                "UPDATE `{$invitations}` SET revoked_at=NOW()
                 WHERE user_account_id=? AND used_at IS NULL AND revoked_at IS NULL"
            );
            $revoke->bind_param('i', $accountId);
            $revoke->execute();
            $revoke->close();

            $revokeSessions = $this->connection->prepare(
                "UPDATE `{$sessions}` SET revoked_at=NOW() WHERE user_account_id=? AND revoked_at IS NULL"
            );
            $revokeSessions->bind_param('i', $accountId);
            $revokeSessions->execute();
            $revokeSessions->close();

            $token = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $token);
            $expiresAt = (new DateTimeImmutable('+14 days'))->format('Y-m-d H:i:s');
            $insertInvite = $this->connection->prepare(
                "INSERT INTO `{$invitations}`
                    (user_account_id, member_id, token_hash, created_by_user_account_id, expires_at)
                 VALUES (?, ?, ?, ?, ?)"
            );
            $insertInvite->bind_param('iisis', $accountId, $memberId, $tokenHash, $createdByUserAccountId, $expiresAt);
            $insertInvite->execute();
            $insertInvite->close();

            $this->connection->commit();

            return [
                'token' => $token,
                'expires_at' => $expiresAt,
                'account' => [
                    'id' => $accountId,
                    'email' => $email ?? ($account['email'] ?? null),
                    'status' => 'invited',
                ],
                'member' => [
                    'id' => $memberId,
                    'name' => (string) $member['navn'],
                ],
            ];
        } catch (mysqli_sql_exception $error) {
            $this->connection->rollback();
            if ((int) $error->getCode() === 1062) {
                throw new InvalidArgumentException('E-postadressen eller medlemskoblingen er allerede i bruk.', 0, $error);
            }
            throw $error;
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @return array<string,mixed> */
    public function inspectInvitation(string $token): array
    {
        $tokenHash = $this->tokenHash($token);
        $users = $this->prefix . 'user_accounts';
        $invitations = $this->prefix . 'user_onboarding_invitations';

        $stmt = $this->connection->prepare(
            "SELECT i.id, i.expires_at, i.member_id, ua.id AS account_id, ua.email, ua.account_status, m.navn AS member_name
             FROM `{$invitations}` i
             INNER JOIN `{$users}` ua ON ua.id=i.user_account_id
             INNER JOIN `medlemmer` m ON m.id=i.member_id
             WHERE i.token_hash=?
               AND i.used_at IS NULL
               AND i.revoked_at IS NULL
               AND i.expires_at > NOW()
             LIMIT 1"
        );
        $stmt->bind_param('s', $tokenHash);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($row === null) {
            throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
        }

        return [
            'member' => [
                'id' => (int) $row['member_id'],
                'name' => (string) $row['member_name'],
            ],
            'account' => [
                'id' => (int) $row['account_id'],
                'email' => $row['email'] !== null ? (string) $row['email'] : null,
                'status' => (string) $row['account_status'],
            ],
            'expires_at' => (string) $row['expires_at'],
        ];
    }

    /** @return array{member:array<string,mixed>,account:array<string,mixed>} */
    public function completeInvitation(string $token, string $email, string $password): array
    {
        $email = $this->normalizeRequiredEmail($email);
        $passwordLength = mb_strlen($password, 'UTF-8');
        if ($passwordLength < 10) {
            throw new InvalidArgumentException('Passordet må være minst 10 tegn.');
        }
        if ($passwordLength > 200) {
            throw new InvalidArgumentException('Passordet er for langt.');
        }

        $tokenHash = $this->tokenHash($token);
        $users = $this->prefix . 'user_accounts';
        $players = $this->prefix . 'players';
        $invitations = $this->prefix . 'user_onboarding_invitations';

        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare(
                "SELECT i.id, i.user_account_id, i.member_id, m.navn AS member_name
                 FROM `{$invitations}` i
                 INNER JOIN `medlemmer` m ON m.id=i.member_id
                 WHERE i.token_hash=?
                   AND i.used_at IS NULL
                   AND i.revoked_at IS NULL
                   AND i.expires_at > NOW()
                 LIMIT 1 FOR UPDATE"
            );
            $stmt->bind_param('s', $tokenHash);
            $stmt->execute();
            $invite = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($invite === null) {
                throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
            }

            $accountId = (int) $invite['user_account_id'];
            $memberId = (int) $invite['member_id'];
            $this->assertEmailAvailable($email, $accountId);

            $playerStmt = $this->connection->prepare(
                "SELECT id FROM `{$players}` WHERE member_id=? ORDER BY id ASC LIMIT 1"
            );
            $playerStmt->bind_param('i', $memberId);
            $playerStmt->execute();
            $playerRow = $playerStmt->get_result()->fetch_assoc() ?: null;
            $playerStmt->close();
            $playerId = $playerRow !== null ? (int) $playerRow['id'] : null;

            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            if (!is_string($passwordHash) || $passwordHash === '') {
                throw new RuntimeException('Kunne ikke opprette passordhash.');
            }

            $status = 'active';
            $update = $this->connection->prepare(
                "UPDATE `{$users}`
                 SET email=?, password_hash=?, member_id=?, player_id=COALESCE(player_id, ?),
                     account_status=?, is_active=1, claimed_at=NOW()
                 WHERE id=?"
            );
            $update->bind_param('ssii si', $email, $passwordHash, $memberId, $playerId, $status, $accountId);
            $update->close();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        throw new RuntimeException('Onboarding completion did not finish.');
    }

    public function disableAccount(int $memberId): void
    {
        if ($memberId <= 0) {
            throw new InvalidArgumentException('Ugyldig medlem.');
        }

        $users = $this->prefix . 'user_accounts';
        $sessions = $this->prefix . 'auth_sessions';
        $globalRoles = $this->prefix . 'global_user_roles';
        $invitations = $this->prefix . 'user_onboarding_invitations';

        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare("SELECT id FROM `{$users}` WHERE member_id=? LIMIT 1 FOR UPDATE");
            $stmt->bind_param('i', $memberId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($row === null) {
                throw new InvalidArgumentException('Medlemmet har ingen brukerkonto.');
            }
            $accountId = (int) $row['id'];

            $roleStmt = $this->connection->prepare(
                "SELECT 1 FROM `{$globalRoles}` WHERE user_account_id=? AND role='super_admin' LIMIT 1"
            );
            $roleStmt->bind_param('i', $accountId);
            $roleStmt->execute();
            $isSuperAdmin = $roleStmt->get_result()->fetch_assoc() !== null;
            $roleStmt->close();
            if ($isSuperAdmin) {
                throw new InvalidArgumentException('Superadmin kan ikke deaktiveres fra medlemsoversikten.');
            }

            $status = 'disabled';
            $update = $this->connection->prepare(
                "UPDATE `{$users}` SET account_status=?, is_active=0 WHERE id=?"
            );
            $update->bind_param('si', $status, $accountId);
            $update->execute();
            $update->close();

            $revokeSessions = $this->connection->prepare(
                "UPDATE `{$sessions}` SET revoked_at=NOW() WHERE user_account_id=? AND revoked_at IS NULL"
            );
            $revokeSessions->bind_param('i', $accountId);
            $revokeSessions->execute();
            $revokeSessions->close();

            $revokeInvites = $this->connection->prepare(
                "UPDATE `{$invitations}` SET revoked_at=NOW()
                 WHERE user_account_id=? AND used_at IS NULL AND revoked_at IS NULL"
            );
            $revokeInvites->bind_param('i', $accountId);
            $revokeInvites->execute();
            $revokeInvites->close();

            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @return array<string,mixed>|null */
    private function findAccountForMemberOrPlayer(int $memberId, ?int $playerId, bool $forUpdate): ?array
    {
        $users = $this->prefix . 'user_accounts';
        $suffix = $forUpdate ? ' FOR UPDATE' : '';

        $stmt = $this->connection->prepare("SELECT * FROM `{$users}` WHERE member_id=? LIMIT 1{$suffix}");
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row !== null || $playerId === null) {
            return $row;
        }

        $stmt = $this->connection->prepare("SELECT * FROM `{$users}` WHERE player_id=? LIMIT 1{$suffix}");
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function nextInternalUsername(int $memberId): string
    {
        $users = $this->prefix . 'user_accounts';
        $base = 'member-' . $memberId;
        $candidate = $base;
        for ($attempt = 0; $attempt < 10; $attempt++) {
            $stmt = $this->connection->prepare("SELECT 1 FROM `{$users}` WHERE username=? LIMIT 1");
            $stmt->bind_param('s', $candidate);
            $stmt->execute();
            $exists = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            if (!$exists) {
                return $candidate;
            }
            $candidate = $base . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
        }
        throw new RuntimeException('Kunne ikke lage internt brukernavn.');
    }

    private function normalizeOptionalEmail(?string $email): ?string
    {
        $email = $email !== null ? trim($email) : '';
        if ($email === '') {
            return null;
        }
        return $this->normalizeRequiredEmail($email);
    }

    private function normalizeRequiredEmail(string $email): string
    {
        $email = mb_strtolower(trim($email), 'UTF-8');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new InvalidArgumentException('Ugyldig e-postadresse.');
        }
        return $email;
    }

    private function assertEmailAvailable(string $email, int $accountId): void
    {
        $users = $this->prefix . 'user_accounts';
        $stmt = $this->connection->prepare(
            "SELECT id FROM `{$users}` WHERE LOWER(email)=LOWER(?) AND id<>? LIMIT 1"
        );
        $stmt->bind_param('si', $email, $accountId);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        if ($exists) {
            throw new InvalidArgumentException('E-postadressen er allerede i bruk av en annen konto.');
        }
    }

    private function tokenHash(string $token): string
    {
        $token = trim($token);
        if (!preg_match('/^[a-f0-9]{64}$/i', $token)) {
            throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
        }
        return hash('sha256', strtolower($token));
    }
}
