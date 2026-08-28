<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use RuntimeException;
use Throwable;

final class AccountProfileRepository
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

    /** @param array<string,mixed> $user @return array<string,mixed> */
    public function profileForUser(array $user): array
    {
        $playerId = (int) ($user['player_id'] ?? 0);
        $player = null;
        if ($playerId > 0) {
            $players = $this->dataPrefix . 'players';
            $statement = $this->connection->prepare(
                "SELECT id, club_id, member_id, display_name, first_name, last_name, nickname, avatar_url
                   FROM `{$players}` WHERE id = ? LIMIT 1"
            );
            $statement->bind_param('i', $playerId);
            $statement->execute();
            $player = $statement->get_result()->fetch_assoc() ?: null;
            $statement->close();
        }

        return [
            'user_id' => (int) ($user['id'] ?? 0),
            'email' => (string) ($user['email'] ?? $user['contact_email'] ?? ''),
            'display_name' => (string) ($player['display_name'] ?? $user['display_name'] ?? ''),
            'nickname' => $player !== null ? ($player['nickname'] ?? null) : null,
            'avatar_url' => $player !== null ? ($player['avatar_url'] ?? null) : null,
            'player_id' => $playerId > 0 ? $playerId : null,
            'club_id' => $player !== null && $player['club_id'] !== null ? (int) $player['club_id'] : null,
            'member_id' => $player !== null && $player['member_id'] !== null
                ? (int) $player['member_id']
                : ((int) ($user['member_id'] ?? 0) ?: null),
        ];
    }

    /** @return array<string,mixed> */
    public function updateProfile(array $user, string $displayName, ?string $nickname): array
    {
        $displayName = preg_replace('/\s+/u', ' ', trim($displayName)) ?? '';
        $nickname = $nickname !== null ? (preg_replace('/\s+/u', ' ', trim($nickname)) ?? '') : '';

        if (mb_strlen($displayName, 'UTF-8') < 2 || mb_strlen($displayName, 'UTF-8') > 150) {
            throw new ValidationException('profile_name_invalid', 'Navnet må være mellom 2 og 150 tegn.', 422);
        }
        if (mb_strlen($nickname, 'UTF-8') > 120) {
            throw new ValidationException('profile_nickname_invalid', 'Kallenavnet kan være maks 120 tegn.', 422);
        }

        $userId = (int) ($user['id'] ?? 0);
        $playerId = (int) ($user['player_id'] ?? 0);
        if ($userId <= 0) {
            throw new ValidationException('profile_account_missing', 'Brukerkontoen kunne ikke finnes.', 404);
        }

        $this->connection->begin_transaction();
        try {
            // PROD has one canonical data/identity prefix. TEST deliberately keeps
            // production identity shared, so a profile preview in TEST must not
            // silently rename the production account record.
            if ($this->identityPrefix === $this->dataPrefix) {
                $users = $this->identityPrefix . 'user_accounts';
                $account = $this->connection->prepare("UPDATE `{$users}` SET display_name = ?, updated_at = NOW() WHERE id = ?");
                $account->bind_param('si', $displayName, $userId);
                $account->execute();
                $account->close();
            }

            if ($playerId > 0) {
                $players = $this->dataPrefix . 'players';
                $nicknameValue = $nickname !== '' ? $nickname : null;
                $player = $this->connection->prepare(
                    "UPDATE `{$players}` SET display_name = ?, nickname = ?, updated_at = NOW() WHERE id = ?"
                );
                $player->bind_param('ssi', $displayName, $nicknameValue, $playerId);
                $player->execute();
                $player->close();
            }

            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        $updated = $user;
        $updated['display_name'] = $displayName;
        if ($playerId > 0) {
            $updated['player_display_name'] = $displayName;
        }
        $profile = $this->profileForUser($updated);
        $profile['nickname'] = $nickname !== '' ? $nickname : null;
        return $profile;
    }

    public function changePassword(array $user, string $currentPassword, string $newPassword): void
    {
        $userId = (int) ($user['id'] ?? 0);
        $sessionId = (int) ($user['session_id'] ?? 0);
        if ($userId <= 0) {
            throw new ValidationException('profile_account_missing', 'Brukerkontoen kunne ikke finnes.', 404);
        }
        if ($currentPassword === '') {
            throw new ValidationException('current_password_required', 'Skriv inn nåværende passord.', 422);
        }
        if (mb_strlen($newPassword, 'UTF-8') < 8) {
            throw new ValidationException('password_too_short', 'Det nye passordet må være minst 8 tegn.', 422);
        }
        if (hash_equals($currentPassword, $newPassword)) {
            throw new ValidationException('password_unchanged', 'Velg et annet passord enn det du bruker nå.', 422);
        }

        $users = $this->identityPrefix . 'user_accounts';
        $sessions = $this->identityPrefix . 'auth_sessions';
        $lookup = $this->connection->prepare("SELECT password_hash FROM `{$users}` WHERE id = ? AND is_active = 1 LIMIT 1");
        $lookup->bind_param('i', $userId);
        $lookup->execute();
        $row = $lookup->get_result()->fetch_assoc() ?: null;
        $lookup->close();
        if ($row === null || !password_verify($currentPassword, (string) ($row['password_hash'] ?? ''))) {
            throw new ValidationException('current_password_invalid', 'Nåværende passord er ikke riktig.', 422);
        }

        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        if (!is_string($hash) || $hash === '') {
            throw new RuntimeException('Could not hash password.');
        }

        $this->connection->begin_transaction();
        try {
            $update = $this->connection->prepare("UPDATE `{$users}` SET password_hash = ?, updated_at = NOW() WHERE id = ?");
            $update->bind_param('si', $hash, $userId);
            $update->execute();
            $update->close();

            if ($sessionId > 0) {
                $revoke = $this->connection->prepare(
                    "UPDATE `{$sessions}` SET revoked_at = NOW()
                      WHERE user_account_id = ? AND id <> ? AND revoked_at IS NULL"
                );
                $revoke->bind_param('ii', $userId, $sessionId);
            } else {
                $revoke = $this->connection->prepare(
                    "UPDATE `{$sessions}` SET revoked_at = NOW()
                      WHERE user_account_id = ? AND revoked_at IS NULL"
                );
                $revoke->bind_param('i', $userId);
            }
            $revoke->execute();
            $revoke->close();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
        return $prefix;
    }
}
