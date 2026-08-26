<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use InvalidArgumentException;
use mysqli;
use RuntimeException;
use Throwable;

final class SelfRegistrationRepository
{
    private mysqli $connection;
    private string $dataPrefix;
    private string $identityPrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->dataPrefix = $database->tablePrefix();
        $this->identityPrefix = $database->identityTablePrefix();
    }

    /** @return array{token:string,expires_at:string} */
    public function createInvitation(int $clubId, int $createdByUserAccountId): array
    {
        if ($clubId <= 0 || $createdByUserAccountId <= 0) {
            throw new InvalidArgumentException('Ugyldig invitasjonsforespørsel.');
        }
        $table = $this->dataPrefix . 'self_registration_invites';
        $token = bin2hex(random_bytes(32));
        $hash = hash('sha256', $token);
        $expiresAt = (new DateTimeImmutable('+14 days'))->format('Y-m-d H:i:s');
        $stmt = $this->connection->prepare(
            "INSERT INTO `{$table}` (club_id, token_hash, created_by_user_account_id, expires_at) VALUES (?, ?, ?, ?)"
        );
        $stmt->bind_param('isis', $clubId, $hash, $createdByUserAccountId, $expiresAt);
        $stmt->execute();
        $stmt->close();
        return ['token' => $token, 'expires_at' => $expiresAt];
    }

    /** @return array<string,mixed> */
    public function inspectInvitation(string $token): array
    {
        $hash = $this->tokenHash($token);
        $table = $this->dataPrefix . 'self_registration_invites';
        $clubs = $this->dataPrefix . 'clubs';
        $stmt = $this->connection->prepare(
            "SELECT i.id, i.club_id, i.expires_at, i.submitted_at, i.approved_at, i.revoked_at, c.name AS club_name
             FROM `{$table}` i INNER JOIN `{$clubs}` c ON c.id=i.club_id
             WHERE i.token_hash=? AND i.revoked_at IS NULL AND i.expires_at > NOW() LIMIT 1"
        );
        $stmt->bind_param('s', $hash);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
        return [
            'type' => 'self_registration',
            'club' => ['id' => (int) $row['club_id'], 'name' => (string) $row['club_name']],
            'expires_at' => (string) $row['expires_at'],
            'submitted' => $row['submitted_at'] !== null,
            'approved' => $row['approved_at'] !== null,
        ];
    }

    /** @return array<string,mixed> */
    public function submitInvitation(string $token, string $firstName, string $lastName, string $email, string $password): array
    {
        $hash = $this->tokenHash($token);
        $firstName = $this->normalizeName($firstName, 'Fornavn');
        $lastName = $this->normalizeName($lastName, 'Etternavn');
        $email = $this->normalizeEmail($email);
        $passwordLength = mb_strlen($password, 'UTF-8');
        if ($passwordLength < 10 || $passwordLength > 200) {
            throw new InvalidArgumentException($passwordLength < 10 ? 'Passordet må være minst 10 tegn.' : 'Passordet er for langt.');
        }
        $this->assertEmailAvailable($email);
        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        if (!is_string($passwordHash) || $passwordHash === '') throw new RuntimeException('Kunne ikke opprette passordhash.');

        $table = $this->dataPrefix . 'self_registration_invites';
        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare(
                "SELECT id, club_id, submitted_at, approved_at FROM `{$table}`
                 WHERE token_hash=? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE"
            );
            $stmt->bind_param('s', $hash);
            $stmt->execute();
            $invite = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($invite === null) throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
            if ($invite['approved_at'] !== null) throw new InvalidArgumentException('Invitasjonen er allerede ferdigbehandlet.');
            if ($invite['submitted_at'] !== null) throw new InvalidArgumentException('Registreringen er allerede sendt inn.');

            $id = (int) $invite['id'];
            $update = $this->connection->prepare(
                "UPDATE `{$table}` SET first_name=?, last_name=?, email=?, password_hash=?, submitted_at=NOW() WHERE id=?"
            );
            $update->bind_param('ssssi', $firstName, $lastName, $email, $passwordHash, $id);
            $update->execute();
            $update->close();
            $this->connection->commit();
            return ['type' => 'self_registration', 'status' => 'pending_approval', 'name' => $firstName . ' ' . $lastName];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    /** @return list<array<string,mixed>> */
    public function listPending(int $clubId): array
    {
        $table = $this->dataPrefix . 'self_registration_invites';
        $stmt = $this->connection->prepare(
            "SELECT id, first_name, last_name, email, submitted_at, expires_at
             FROM `{$table}`
             WHERE club_id=? AND submitted_at IS NOT NULL AND approved_at IS NULL AND revoked_at IS NULL
             ORDER BY submitted_at ASC"
        );
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map(static fn(array $row): array => [
            'id' => (int) $row['id'],
            'first_name' => (string) $row['first_name'],
            'last_name' => (string) $row['last_name'],
            'display_name' => trim((string) $row['first_name'] . ' ' . (string) $row['last_name']),
            'email' => (string) $row['email'],
            'submitted_at' => (string) $row['submitted_at'],
            'expires_at' => (string) $row['expires_at'],
        ], $rows);
    }

    /** @return array<string,mixed> */
    public function approve(int $clubId, int $inviteId, int $memberId, int $approvedByUserAccountId): array
    {
        if ($clubId <= 0 || $inviteId <= 0 || $memberId <= 0 || $approvedByUserAccountId <= 0) {
            throw new InvalidArgumentException('Ugyldig godkjenning.');
        }
        $table = $this->dataPrefix . 'self_registration_invites';
        $users = $this->identityPrefix . 'user_accounts';
        $players = $this->dataPrefix . 'players';

        $this->connection->begin_transaction();
        try {
            $inviteStmt = $this->connection->prepare(
                "SELECT * FROM `{$table}` WHERE id=? AND club_id=? AND submitted_at IS NOT NULL AND approved_at IS NULL AND revoked_at IS NULL LIMIT 1 FOR UPDATE"
            );
            $inviteStmt->bind_param('ii', $inviteId, $clubId);
            $inviteStmt->execute();
            $invite = $inviteStmt->get_result()->fetch_assoc() ?: null;
            $inviteStmt->close();
            if ($invite === null) throw new InvalidArgumentException('Registreringen finnes ikke eller er allerede behandlet.');

            $memberStmt = $this->connection->prepare('SELECT id, navn FROM `medlemmer` WHERE id=? LIMIT 1 FOR UPDATE');
            $memberStmt->bind_param('i', $memberId);
            $memberStmt->execute();
            $member = $memberStmt->get_result()->fetch_assoc() ?: null;
            $memberStmt->close();
            if ($member === null) throw new InvalidArgumentException('Medlemmet finnes ikke.');

            $email = $this->normalizeEmail((string) $invite['email']);
            $accountStmt = $this->connection->prepare("SELECT * FROM `{$users}` WHERE member_id=? LIMIT 1 FOR UPDATE");
            $accountStmt->bind_param('i', $memberId);
            $accountStmt->execute();
            $account = $accountStmt->get_result()->fetch_assoc() ?: null;
            $accountStmt->close();
            if ($account !== null && (string) $account['account_status'] === 'active') {
                throw new InvalidArgumentException('Medlemmet har allerede en aktiv brukerkonto.');
            }
            $this->assertEmailAvailable($email, $account !== null ? (int) $account['id'] : 0);

            $playerStmt = $this->connection->prepare("SELECT id FROM `{$players}` WHERE club_id=? AND member_id=? ORDER BY id ASC LIMIT 1");
            $playerStmt->bind_param('ii', $clubId, $memberId);
            $playerStmt->execute();
            $localPlayer = $playerStmt->get_result()->fetch_assoc() ?: null;
            $playerStmt->close();
            if ($localPlayer === null) {
                $displayName = trim((string) $member['navn']);
                $firstName = trim((string) $invite['first_name']);
                $lastName = trim((string) $invite['last_name']);
                $insertPlayer = $this->connection->prepare(
                    "INSERT INTO `{$players}` (club_id, display_name, first_name, last_name, is_active, member_id) VALUES (?, ?, ?, ?, 1, ?)"
                );
                $insertPlayer->bind_param('isssi', $clubId, $displayName, $firstName, $lastName, $memberId);
                $insertPlayer->execute();
                $insertPlayer->close();
            }

            $identityPlayerId = $this->identityPlayerIdForMember($memberId);
            $displayName = trim((string) $member['navn']);
            $passwordHash = (string) $invite['password_hash'];
            $status = 'active';
            $role = 'player';
            if ($account === null) {
                $username = $this->nextInternalUsername($memberId);
                $insert = $this->connection->prepare(
                    "INSERT INTO `{$users}` (username, email, password_hash, display_name, player_id, member_id, role, is_active, account_status, invited_at, claimed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())"
                );
                $insert->bind_param('ssssiiss', $username, $email, $passwordHash, $displayName, $identityPlayerId, $memberId, $role, $status);
                $insert->execute();
                $accountId = (int) $insert->insert_id;
                $insert->close();
            } else {
                $accountId = (int) $account['id'];
                $update = $this->connection->prepare(
                    "UPDATE `{$users}` SET email=?, password_hash=?, display_name=?, player_id=COALESCE(player_id, ?), member_id=?, role=?, is_active=1, account_status=?, claimed_at=NOW() WHERE id=?"
                );
                $update->bind_param('sssiissi', $email, $passwordHash, $displayName, $identityPlayerId, $memberId, $role, $status, $accountId);
                $update->execute();
                $update->close();
            }

            $approveStmt = $this->connection->prepare(
                "UPDATE `{$table}` SET approved_member_id=?, approved_by_user_account_id=?, approved_at=NOW(), password_hash=NULL WHERE id=?"
            );
            $approveStmt->bind_param('iii', $memberId, $approvedByUserAccountId, $inviteId);
            $approveStmt->execute();
            $approveStmt->close();
            $this->connection->commit();

            return ['status' => 'active', 'member_id' => $memberId, 'account_id' => $accountId, 'name' => $displayName];
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    private function identityPlayerIdForMember(int $memberId): ?int
    {
        $players = $this->identityPrefix . 'players';
        $stmt = $this->connection->prepare("SELECT id FROM `{$players}` WHERE member_id=? ORDER BY id ASC LIMIT 1");
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row !== null ? (int) $row['id'] : null;
    }

    private function nextInternalUsername(int $memberId): string
    {
        $users = $this->identityPrefix . 'user_accounts';
        $base = 'member-' . $memberId;
        for ($attempt = 0; $attempt < 12; $attempt++) {
            $candidate = $attempt === 0 ? $base : $base . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
            $stmt = $this->connection->prepare("SELECT 1 FROM `{$users}` WHERE username=? LIMIT 1");
            $stmt->bind_param('s', $candidate);
            $stmt->execute();
            $exists = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            if (!$exists) return $candidate;
        }
        throw new RuntimeException('Kunne ikke lage internt brukernavn.');
    }

    private function assertEmailAvailable(string $email, int $accountId = 0): void
    {
        $users = $this->identityPrefix . 'user_accounts';
        $stmt = $this->connection->prepare("SELECT id FROM `{$users}` WHERE LOWER(email)=LOWER(?) AND id<>? LIMIT 1");
        $stmt->bind_param('si', $email, $accountId);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        if ($exists) throw new InvalidArgumentException('E-postadressen er allerede i bruk av en annen konto.');
    }

    private function normalizeEmail(string $email): string
    {
        $email = mb_strtolower(trim($email), 'UTF-8');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new InvalidArgumentException('Ugyldig e-postadresse.');
        return $email;
    }

    private function normalizeName(string $value, string $label): string
    {
        $value = trim(preg_replace('/\s+/u', ' ', $value) ?? '');
        $length = mb_strlen($value, 'UTF-8');
        if ($length < 2 || $length > 120) throw new InvalidArgumentException($label . ' må fylles ut.');
        return $value;
    }

    private function tokenHash(string $token): string
    {
        $token = trim($token);
        if (!preg_match('/^[a-f0-9]{64}$/i', $token)) throw new InvalidArgumentException('Invitasjonslenken er ugyldig eller utløpt.');
        return hash('sha256', strtolower($token));
    }
}
