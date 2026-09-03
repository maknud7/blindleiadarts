<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli;
use RuntimeException;
use Throwable;

final class PlayerMemberLinkRepository
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

    /** @return array{players:list<array<string,mixed>>,members:list<array<string,mixed>>} */
    public function overview(int $clubId): array
    {
        if ($clubId <= 0) throw new InvalidArgumentException('Ugyldig klubb.');

        $players = $this->dataPrefix . 'players';
        $matches = $this->dataPrefix . 'matches';
        $tournaments = $this->dataPrefix . 'tournaments';

        $stmt = $this->connection->prepare(
            "SELECT p.id,p.display_name,p.member_link_source,
                    COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.id END) AS completed_matches,
                    COUNT(DISTINCT CASE WHEN m.status='completed' THEN m.tournament_id END) AS tournament_count
               FROM `{$players}` p
               LEFT JOIN `{$matches}` m ON m.player_a_id=p.id OR m.player_b_id=p.id
               LEFT JOIN `{$tournaments}` t ON t.id=m.tournament_id
              WHERE p.club_id=?
                AND p.member_id IS NULL
                AND p.is_active=1
                AND p.merged_into_player_id IS NULL
              GROUP BY p.id,p.display_name,p.member_link_source
              ORDER BY p.display_name,p.id"
        );
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $unlinked = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($unlinked as &$row) {
            $row['id'] = (int) $row['id'];
            $row['completed_matches'] = (int) $row['completed_matches'];
            $row['tournament_count'] = (int) $row['tournament_count'];
        }
        unset($row);

        $stmt = $this->connection->prepare(
            "SELECT m.id,m.medlemsnummer,m.navn,
                    p.id AS linked_player_id,p.display_name AS linked_player_name
               FROM `medlemmer` m
               LEFT JOIN `{$players}` p ON p.id=(
                    SELECT MIN(p2.id)
                      FROM `{$players}` p2
                     WHERE p2.club_id=?
                       AND p2.member_id=m.id
                       AND p2.merged_into_player_id IS NULL
               )
              ORDER BY m.navn,m.id"
        );
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $members = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($members as &$row) {
            $row['id'] = (int) $row['id'];
            $row['member_number'] = isset($row['medlemsnummer']) ? (int) $row['medlemsnummer'] : null;
            $row['name'] = (string) ($row['navn'] ?? '');
            $row['linked_player_id'] = $row['linked_player_id'] !== null ? (int) $row['linked_player_id'] : null;
            $row['linked_player_name'] = $row['linked_player_name'] !== null ? (string) $row['linked_player_name'] : null;
            unset($row['medlemsnummer'], $row['navn']);
        }
        unset($row);

        return ['players' => $unlinked, 'members' => $members];
    }

    /** @return array<string,mixed> */
    public function link(int $clubId, int $playerId, int $memberId, int $actorAccountId): array
    {
        if ($clubId <= 0 || $playerId <= 0 || $memberId <= 0 || $actorAccountId <= 0) {
            throw new InvalidArgumentException('Spiller og medlem må velges.');
        }

        $players = $this->dataPrefix . 'players';
        $audit = $this->dataPrefix . 'player_member_link_audit';
        $users = $this->identityPrefix . 'user_accounts';

        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare(
                "SELECT id,display_name,member_id FROM `{$players}`
                  WHERE id=? AND club_id=? AND is_active=1 AND merged_into_player_id IS NULL
                  LIMIT 1 FOR UPDATE"
            );
            $stmt->bind_param('ii', $playerId, $clubId);
            $stmt->execute();
            $player = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($player === null) throw new InvalidArgumentException('Spilleren finnes ikke i valgt klubb.');

            $currentMemberId = $player['member_id'] !== null ? (int) $player['member_id'] : null;
            if ($currentMemberId !== null) {
                if ($currentMemberId === $memberId) {
                    $this->connection->commit();
                    return [
                        'player_id' => $playerId,
                        'player_name' => (string) $player['display_name'],
                        'member_id' => $memberId,
                        'already_linked' => true,
                    ];
                }
                throw new InvalidArgumentException('Spilleren er allerede koblet til et annet medlem.');
            }

            $stmt = $this->connection->prepare('SELECT id,navn,medlemsnummer FROM `medlemmer` WHERE id=? LIMIT 1');
            $stmt->bind_param('i', $memberId);
            $stmt->execute();
            $member = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($member === null) throw new InvalidArgumentException('Medlemmet finnes ikke i medlemsregisteret.');

            $stmt = $this->connection->prepare(
                "SELECT id,display_name FROM `{$players}`
                  WHERE club_id=? AND member_id=? AND id<>? AND merged_into_player_id IS NULL
                  ORDER BY id LIMIT 1 FOR UPDATE"
            );
            $stmt->bind_param('iii', $clubId, $memberId, $playerId);
            $stmt->execute();
            $conflict = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($conflict !== null) {
                throw new InvalidArgumentException(
                    'Medlemmet er allerede koblet til spiller #' . (int) $conflict['id'] . ' ' . (string) $conflict['display_name'] . '. Bruk spilleropprydding hvis dette er en duplikat.'
                );
            }

            // In PROD, identity and domain share the same prefix. TEST may read canonical
            // identity, but must never mutate it from an isolated tournament environment.
            if ($this->identityPrefix === $this->dataPrefix) {
                $this->reconcileCanonicalAccount($clubId, $playerId, $memberId, $users);
            }

            $source = 'club_admin_manual';
            $stmt = $this->connection->prepare(
                "UPDATE `{$players}`
                    SET member_id=?,member_link_source=?,member_linked_at=NOW()
                  WHERE id=? AND club_id=? AND member_id IS NULL"
            );
            $stmt->bind_param('isii', $memberId, $source, $playerId, $clubId);
            $stmt->execute();
            if ($stmt->affected_rows !== 1) {
                $stmt->close();
                throw new RuntimeException('Spillerkoblingen ble ikke lagret.');
            }
            $stmt->close();

            $playerName = (string) $player['display_name'];
            $memberName = (string) $member['navn'];
            $stmt = $this->connection->prepare(
                "INSERT INTO `{$audit}`
                    (club_id,player_id,player_display_name,member_id,member_name,actor_user_account_id,link_source)
                 VALUES (?,?,?,?,?,?,?)"
            );
            $stmt->bind_param('iisisis', $clubId, $playerId, $playerName, $memberId, $memberName, $actorAccountId, $source);
            $stmt->execute();
            $stmt->close();

            $this->connection->commit();
            return [
                'player_id' => $playerId,
                'player_name' => $playerName,
                'member_id' => $memberId,
                'member_name' => $memberName,
                'member_number' => isset($member['medlemsnummer']) ? (int) $member['medlemsnummer'] : null,
                'already_linked' => false,
            ];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    private function reconcileCanonicalAccount(int $clubId, int $playerId, int $memberId, string $users): void
    {
        $clubRoles = $this->identityPrefix . 'club_user_roles';
        $globalRoles = $this->identityPrefix . 'global_user_roles';
        $sessions = $this->identityPrefix . 'auth_sessions';

        $stmt = $this->connection->prepare(
            "SELECT id,member_id,player_id,is_active,account_status,last_login_at
               FROM `{$users}`
              WHERE member_id=?
              ORDER BY id
              FOR UPDATE"
        );
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $targetAccounts = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        if (count($targetAccounts) > 1) {
            throw new InvalidArgumentException('Medlemmet har flere brukerkontoer. Rydd kontoidentiteten før spillerkobling.');
        }
        $targetAccount = $targetAccounts[0] ?? null;

        $stmt = $this->connection->prepare(
            "SELECT id,member_id,player_id,is_active,account_status,last_login_at
               FROM `{$users}`
              WHERE player_id=?
              ORDER BY id
              FOR UPDATE"
        );
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $ownerAccounts = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        if (count($ownerAccounts) > 1) {
            throw new InvalidArgumentException('Spiller-ID-en er koblet til flere brukerkontoer. Rydd kontoidentiteten før spillerkobling.');
        }
        $ownerAccount = $ownerAccounts[0] ?? null;

        if ($targetAccount !== null && $targetAccount['player_id'] !== null && (int) $targetAccount['player_id'] !== $playerId) {
            throw new InvalidArgumentException('Medlemmet har allerede en brukerkonto koblet til en annen spiller-ID. Rydd identiteten før kobling.');
        }

        if ($ownerAccount !== null && $ownerAccount['member_id'] !== null && (int) $ownerAccount['member_id'] !== $memberId) {
            throw new InvalidArgumentException('Spiller-ID-en tilhører allerede en brukerkonto for et annet medlem. Rydd identiteten før kobling.');
        }

        // If there is no separate member account, enrich the existing player account
        // instead of creating another identity island. This preserves an active player login.
        if ($targetAccount === null) {
            if ($ownerAccount !== null && $ownerAccount['member_id'] === null) {
                $ownerId = (int) $ownerAccount['id'];
                $stmt = $this->connection->prepare(
                    "UPDATE `{$users}` SET member_id=? WHERE id=? AND member_id IS NULL"
                );
                $stmt->bind_param('ii', $memberId, $ownerId);
                $stmt->execute();
                if ($stmt->affected_rows !== 1) {
                    $stmt->close();
                    throw new RuntimeException('Brukerkontoen kunne ikke kobles til medlemmet.');
                }
                $stmt->close();
            }
            return;
        }

        $targetId = (int) $targetAccount['id'];
        if ($ownerAccount !== null && (int) $ownerAccount['id'] !== $targetId) {
            if (!$this->isSafeLegacyPlaceholder($ownerAccount)) {
                throw new InvalidArgumentException('Spiller-ID-en brukes av en annen aktiv eller registrert brukerkonto. Rydd kontoidentiteten før kobling.');
            }

            $ownerId = (int) $ownerAccount['id'];
            $stmt = $this->connection->prepare("SELECT COUNT(*) AS cnt FROM `{$sessions}` WHERE user_account_id=?");
            $stmt->bind_param('i', $ownerId);
            $stmt->execute();
            $sessionCount = (int) (($stmt->get_result()->fetch_assoc()['cnt'] ?? 0));
            $stmt->close();
            if ($sessionCount > 0) {
                throw new InvalidArgumentException('Den gamle spillerkontoen har innloggingshistorikk og må ryddes manuelt før kobling.');
            }

            // Preserve all explicit permissions on the canonical member account before
            // stripping the inactive placeholder. INSERT IGNORE handles already shared roles.
            $stmt = $this->connection->prepare(
                "INSERT IGNORE INTO `{$clubRoles}` (club_id,user_account_id,role)
                 SELECT club_id,?,role FROM `{$clubRoles}` WHERE user_account_id=?"
            );
            $stmt->bind_param('ii', $targetId, $ownerId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare(
                "INSERT IGNORE INTO `{$globalRoles}` (user_account_id,role)
                 SELECT ?,role FROM `{$globalRoles}` WHERE user_account_id=?"
            );
            $stmt->bind_param('ii', $targetId, $ownerId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare("DELETE FROM `{$clubRoles}` WHERE user_account_id=?");
            $stmt->bind_param('i', $ownerId);
            $stmt->execute();
            $stmt->close();

            $stmt = $this->connection->prepare("DELETE FROM `{$globalRoles}` WHERE user_account_id=?");
            $stmt->bind_param('i', $ownerId);
            $stmt->execute();
            $stmt->close();

            // Keep the old row for foreign-key/history integrity, but remove all domain
            // identity and privileges. It stays inactive + unclaimed and cannot own player data.
            $stmt = $this->connection->prepare(
                "UPDATE `{$users}`
                    SET player_id=NULL,is_active=0
                  WHERE id=? AND member_id IS NULL AND player_id=? AND is_active=0 AND account_status='unclaimed'"
            );
            $stmt->bind_param('ii', $ownerId, $playerId);
            $stmt->execute();
            if ($stmt->affected_rows !== 1) {
                $stmt->close();
                throw new RuntimeException('Den gamle spillerkontoen kunne ikke frikobles trygt.');
            }
            $stmt->close();
        }

        if ($targetAccount['player_id'] === null) {
            $stmt = $this->connection->prepare(
                "UPDATE `{$users}` SET player_id=? WHERE id=? AND member_id=? AND player_id IS NULL"
            );
            $stmt->bind_param('iii', $playerId, $targetId, $memberId);
            $stmt->execute();
            if ($stmt->affected_rows !== 1) {
                $stmt->close();
                throw new RuntimeException('Medlemmets brukerkonto kunne ikke kobles til spiller-ID-en.');
            }
            $stmt->close();
        }
    }

    /** @param array<string,mixed> $account */
    private function isSafeLegacyPlaceholder(array $account): bool
    {
        return $account['member_id'] === null
            && (int) ($account['is_active'] ?? 1) === 0
            && (string) ($account['account_status'] ?? '') === 'unclaimed'
            && ($account['last_login_at'] === null || trim((string) $account['last_login_at']) === '');
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) throw new RuntimeException('Invalid database table prefix.');
        return $prefix;
    }
}
