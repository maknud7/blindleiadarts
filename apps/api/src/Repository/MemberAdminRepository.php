<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli;
use RuntimeException;
use Throwable;

final class MemberAdminRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $identityPrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $this->safePrefix($database->tablePrefix());
        $this->identityPrefix = $this->safePrefix($database->identityTablePrefix());
    }

    /** @return array{items:list<array<string,mixed>>,summary:array<string,int>} */
    public function listMembers(int $clubId): array
    {
        if ($clubId <= 0) {
            throw new InvalidArgumentException('Ugyldig klubb.');
        }

        $identityClubId = $this->identityClubId($clubId);
        $players = $this->dataPrefix . 'players';
        $users = $this->identityPrefix . 'user_accounts';
        $invitations = $this->identityPrefix . 'user_onboarding_invitations';
        $globalRoles = $this->identityPrefix . 'global_user_roles';
        $clubRoles = $this->identityPrefix . 'club_user_roles';

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
                    (SELECT COUNT(*) FROM `{$users}` uac WHERE uac.member_id=m.id) AS account_count,
                    CASE
                        WHEN ua.id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM `{$globalRoles}` gur
                            WHERE gur.user_account_id=ua.id AND gur.role='super_admin'
                        ) THEN 'super_admin'
                        WHEN ua.id IS NOT NULL AND ? > 0 AND EXISTS (
                            SELECT 1 FROM `{$clubRoles}` cur
                            WHERE cur.user_account_id=ua.id AND cur.club_id=? AND cur.role='club_admin'
                        ) THEN 'club_admin'
                        ELSE 'player'
                    END AS access_level,
                    (SELECT MAX(i.expires_at)
                       FROM `{$invitations}` i
                      WHERE i.user_account_id=ua.id
                        AND i.used_at IS NULL
                        AND i.revoked_at IS NULL
                        AND i.expires_at > NOW()) AS invite_expires_at
                FROM `medlemmer` m
                LEFT JOIN `{$players}` p ON p.id=(
                    SELECT MIN(p0.id)
                    FROM `{$players}` p0
                    WHERE p0.club_id=? AND p0.member_id=m.id
                )
                LEFT JOIN `{$users}` ua ON ua.id=(
                    SELECT ua0.id
                    FROM `{$users}` ua0
                    WHERE ua0.member_id=m.id
                    ORDER BY
                        CASE ua0.account_status
                            WHEN 'active' THEN 0
                            WHEN 'invited' THEN 1
                            WHEN 'unclaimed' THEN 2
                            WHEN 'disabled' THEN 3
                            ELSE 4
                        END,
                        ua0.id DESC
                    LIMIT 1
                )
                ORDER BY m.navn ASC, m.id ASC";

        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $identityClubId, $identityClubId, $clubId);
        $stmt->execute();
        $result = $stmt->get_result();

        $items = [];
        $seenMembers = [];
        $summary = [
            'members' => 0,
            'with_player' => 0,
            'without_account' => 0,
            'unclaimed' => 0,
            'invited' => 0,
            'active' => 0,
            'disabled' => 0,
            'members_with_multiple_accounts' => 0,
        ];

        while ($row = $result->fetch_assoc()) {
            $memberId = (int) ($row['member_id'] ?? 0);
            if ($memberId <= 0 || isset($seenMembers[$memberId])) {
                continue;
            }
            $seenMembers[$memberId] = true;

            $status = $row['account_id'] === null ? 'none' : (string) ($row['account_status'] ?? 'unclaimed');
            $summary['members']++;
            if ($row['player_id'] !== null) {
                $summary['with_player']++;
            }
            if ((int) ($row['account_count'] ?? 0) > 1) {
                $summary['members_with_multiple_accounts']++;
            }
            if ($status === 'none') {
                $summary['without_account']++;
            } elseif (isset($summary[$status])) {
                $summary[$status]++;
            }

            $items[] = [
                'member_id' => $memberId,
                'member_name' => (string) ($row['member_name'] ?? ''),
                'player' => $row['player_id'] !== null ? [
                    'id' => (int) $row['player_id'],
                    'display_name' => (string) ($row['player_name'] ?? ''),
                ] : null,
                'account' => $row['account_id'] !== null ? [
                    'id' => (int) $row['account_id'],
                    'email' => $row['email'] !== null ? (string) $row['email'] : null,
                    'status' => $status,
                    'access_level' => (string) ($row['access_level'] ?? 'player'),
                    'can_manage_access' => $row['player_id'] !== null,
                    'invited_at' => $row['invited_at'],
                    'claimed_at' => $row['claimed_at'],
                    'last_login_at' => $row['last_login_at'],
                    'invite_expires_at' => $row['invite_expires_at'],
                    'duplicate_account_count' => (int) ($row['account_count'] ?? 0),
                ] : null,
            ];
        }

        $result->free();
        $stmt->close();
        return ['items' => $items, 'summary' => $summary];
    }

    /**
     * Club admins may switch player <-> club_admin in the selected club.
     * Only super admins may assign or remove the global super_admin role.
     *
     * @return array{account_id:int,access_level:string}
     */
    public function setAccessLevel(
        int $clubId,
        int $targetAccountId,
        string $accessLevel,
        int $actorAccountId,
        bool $actorIsSuperAdmin
    ): array {
        if ($clubId <= 0 || $targetAccountId <= 0 || $actorAccountId <= 0) {
            throw new InvalidArgumentException('Klubb og brukerkonto må angis.');
        }
        if ($targetAccountId === $actorAccountId) {
            throw new InvalidArgumentException('Du kan ikke endre ditt eget tilgangsnivå her.');
        }

        $accessLevel = strtolower(trim($accessLevel));
        if (!in_array($accessLevel, ['player', 'club_admin', 'super_admin'], true)) {
            throw new InvalidArgumentException('Ugyldig tilgangsnivå.');
        }
        if ($accessLevel === 'super_admin' && !$actorIsSuperAdmin) {
            throw new InvalidArgumentException('Bare superadmin kan gi superadmin-tilgang.');
        }

        $identityClubId = $this->identityClubId($clubId);
        if ($identityClubId <= 0) {
            throw new RuntimeException('Kunne ikke finne klubbens canonical identitet.');
        }

        $users = $this->identityPrefix . 'user_accounts';
        $globalRoles = $this->identityPrefix . 'global_user_roles';
        $clubRoles = $this->identityPrefix . 'club_user_roles';
        $players = $this->dataPrefix . 'players';

        $targetStmt = $this->connection->prepare(
            "SELECT id, member_id, account_status FROM `{$users}` WHERE id=? LIMIT 1"
        );
        $targetStmt->bind_param('i', $targetAccountId);
        $targetStmt->execute();
        $target = $targetStmt->get_result()->fetch_assoc() ?: null;
        $targetStmt->close();
        if ($target === null) {
            throw new InvalidArgumentException('Brukerkontoen finnes ikke.');
        }
        if ((string) ($target['account_status'] ?? '') !== 'active') {
            throw new InvalidArgumentException('Tilgang kan endres etter at brukerkontoen er aktivert.');
        }

        $memberId = (int) ($target['member_id'] ?? 0);
        if ($memberId <= 0) {
            throw new InvalidArgumentException('Brukerkontoen er ikke koblet til et medlem.');
        }

        $membershipStmt = $this->connection->prepare(
            "SELECT 1 FROM `{$players}` WHERE club_id=? AND member_id=? LIMIT 1"
        );
        $membershipStmt->bind_param('ii', $clubId, $memberId);
        $membershipStmt->execute();
        $belongsToClub = $membershipStmt->get_result()->fetch_assoc() !== null;
        $membershipStmt->close();
        if (!$belongsToClub) {
            throw new InvalidArgumentException('Brukeren tilhører ikke den valgte klubben.');
        }

        $superStmt = $this->connection->prepare(
            "SELECT 1 FROM `{$globalRoles}` WHERE user_account_id=? AND role='super_admin' LIMIT 1"
        );
        $superStmt->bind_param('i', $targetAccountId);
        $superStmt->execute();
        $targetIsSuperAdmin = $superStmt->get_result()->fetch_assoc() !== null;
        $superStmt->close();
        if ($targetIsSuperAdmin && !$actorIsSuperAdmin) {
            throw new InvalidArgumentException('Bare superadmin kan endre tilgang for en annen superadmin.');
        }

        $this->connection->begin_transaction();
        try {
            if ($actorIsSuperAdmin) {
                $deleteGlobal = $this->connection->prepare(
                    "DELETE FROM `{$globalRoles}` WHERE user_account_id=? AND role='super_admin'"
                );
                $deleteGlobal->bind_param('i', $targetAccountId);
                $deleteGlobal->execute();
                $deleteGlobal->close();

                if ($accessLevel === 'super_admin') {
                    $role = 'super_admin';
                    $insertGlobal = $this->connection->prepare(
                        "INSERT INTO `{$globalRoles}` (user_account_id, role)
                         VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE role=VALUES(role), updated_at=NOW()"
                    );
                    $insertGlobal->bind_param('is', $targetAccountId, $role);
                    $insertGlobal->execute();
                    $insertGlobal->close();
                }
            }

            // This deletion is intentionally scoped to the selected club. It must
            // never revoke club_admin from another club.
            $deleteClub = $this->connection->prepare(
                "DELETE FROM `{$clubRoles}` WHERE club_id=? AND user_account_id=? AND role='club_admin'"
            );
            $deleteClub->bind_param('ii', $identityClubId, $targetAccountId);
            $deleteClub->execute();
            $deleteClub->close();

            if ($accessLevel === 'club_admin') {
                $role = 'club_admin';
                $insertClub = $this->connection->prepare(
                    "INSERT INTO `{$clubRoles}` (club_id, user_account_id, role)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE role=VALUES(role), updated_at=NOW()"
                );
                $insertClub->bind_param('iis', $identityClubId, $targetAccountId, $role);
                $insertClub->execute();
                $insertClub->close();
            }

            // user_accounts.role is legacy compatibility only. Recalculate it from
            // all remaining canonical role rows instead of blindly copying the role
            // chosen for this one club.
            $legacyRole = $this->legacyRoleForAccount($targetAccountId, $globalRoles, $clubRoles);
            $updateLegacy = $this->connection->prepare(
                "UPDATE `{$users}` SET role=? WHERE id=?"
            );
            $updateLegacy->bind_param('si', $legacyRole, $targetAccountId);
            $updateLegacy->execute();
            $updateLegacy->close();

            $this->connection->commit();
            return ['account_id' => $targetAccountId, 'access_level' => $accessLevel];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    private function legacyRoleForAccount(int $accountId, string $globalRoles, string $clubRoles): string
    {
        $stmt = $this->connection->prepare(
            "SELECT
                EXISTS(SELECT 1 FROM `{$globalRoles}` WHERE user_account_id=? AND role='super_admin') AS is_super,
                EXISTS(SELECT 1 FROM `{$clubRoles}` WHERE user_account_id=? AND role='club_admin') AS is_club_admin"
        );
        $stmt->bind_param('ii', $accountId, $accountId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();

        if ((int) ($row['is_super'] ?? 0) === 1) {
            return 'super_admin';
        }
        if ((int) ($row['is_club_admin'] ?? 0) === 1) {
            return 'club_admin';
        }
        return 'player';
    }

    private function identityClubId(int $localClubId): int
    {
        if ($localClubId <= 0) {
            return 0;
        }
        if ($this->identityPrefix === $this->dataPrefix) {
            return $localClubId;
        }

        $localClubs = $this->dataPrefix . 'clubs';
        $identityClubs = $this->identityPrefix . 'clubs';
        $stmt = $this->connection->prepare(
            "SELECT ic.id
               FROM `{$localClubs}` lc
               INNER JOIN `{$identityClubs}` ic ON ic.slug=lc.slug
              WHERE lc.id=? LIMIT 1"
        );
        $stmt->bind_param('i', $localClubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row !== null ? (int) $row['id'] : 0;
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
        return $prefix;
    }
}
