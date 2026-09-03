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

            // In PROD, identity and domain share the same prefix. Do not touch canonical
            // PROD user accounts when this repository is running against isolated TEST data.
            if ($this->identityPrefix === $this->dataPrefix) {
                $stmt = $this->connection->prepare(
                    "SELECT id,player_id FROM `{$users}` WHERE member_id=? ORDER BY id"
                );
                $stmt->bind_param('i', $memberId);
                $stmt->execute();
                $accounts = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
                $stmt->close();
                foreach ($accounts as $account) {
                    if ($account['player_id'] !== null && (int) $account['player_id'] !== $playerId) {
                        throw new InvalidArgumentException('Medlemmet har allerede en brukerkonto koblet til en annen spiller-ID. Rydd identiteten før kobling.');
                    }
                }
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

            if ($this->identityPrefix === $this->dataPrefix) {
                $stmt = $this->connection->prepare(
                    "UPDATE `{$users}` SET player_id=? WHERE member_id=? AND player_id IS NULL"
                );
                $stmt->bind_param('ii', $playerId, $memberId);
                $stmt->execute();
                $stmt->close();
            }

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

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) throw new RuntimeException('Invalid database table prefix.');
        return $prefix;
    }
}
