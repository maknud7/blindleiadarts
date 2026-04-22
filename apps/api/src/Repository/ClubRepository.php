<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class ClubRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listClubs(): array
    {
        $sql = sprintf(
            'SELECT
                c.id,
                c.name,
                c.slug,
                c.logo_url,
                COUNT(DISTINCT p.id) AS player_count,
                COUNT(DISTINCT k.id) AS kiosk_count,
                COUNT(DISTINCT CASE WHEN t.status IN ("draft", "ready", "in_progress") THEN t.id END) AS active_tournament_count
             FROM `%1$sclubs` c
             LEFT JOIN `%1$splayers` p ON p.club_id = c.id AND p.is_active = 1
             LEFT JOIN `%1$skiosks` k ON k.club_id = c.id AND k.is_active = 1
             LEFT JOIN `%1$stournaments` t ON t.club_id = c.id
             GROUP BY c.id, c.name, c.slug, c.logo_url
             ORDER BY c.name ASC',
            $this->tablePrefix
        );

        $result = $this->connection->query($sql);
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        return $rows;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findById(int $clubId): ?array
    {
        $sql = sprintf(
            'SELECT id, name, slug, logo_url, created_at, updated_at
             FROM `%1$sclubs`
             WHERE id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getDashboard(int $clubId): ?array
    {
        $club = $this->findById($clubId);

        if ($club === null) {
            return null;
        }

        return [
            'club' => $club,
            'players' => $this->listPlayersByClubId($clubId),
            'kiosks' => $this->listKiosksByClubId($clubId),
            'tournaments' => $this->listTournamentSummaries($clubId),
            'recent_matches' => $this->listRecentMatches($clubId),
        ];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function createClub(array $payload): array
    {
        $name = trim((string) ($payload['name'] ?? ''));
        $slug = $this->slugify((string) ($payload['slug'] ?? $name));
        $logoUrl = $this->nullableString($payload['logo_url'] ?? null);

        $sql = sprintf(
            'INSERT INTO `%1$sclubs` (name, slug, logo_url) VALUES (?, ?, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('sss', $name, $slug, $logoUrl);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $this->findById($id) ?? [];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listPlayersByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                p.id,
                p.display_name,
                p.first_name,
                p.last_name,
                p.nickname,
                p.avatar_url,
                p.is_active,
                ua.id AS user_account_id,
                ua.username,
                ua.role
             FROM `%1$splayers` p
             LEFT JOIN `%1$smember_profiles` mp ON mp.player_id = p.id
             LEFT JOIN `%1$suser_accounts` ua ON ua.id = mp.user_account_id
             WHERE p.club_id = ?
             ORDER BY p.display_name ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function createPlayer(int $clubId, array $payload): array
    {
        $displayName = trim((string) ($payload['display_name'] ?? ''));
        $firstName = $this->nullableString($payload['first_name'] ?? null);
        $lastName = $this->nullableString($payload['last_name'] ?? null);
        $nickname = $this->nullableString($payload['nickname'] ?? null);
        $avatarUrl = $this->nullableString($payload['avatar_url'] ?? null);
        $contactEmail = $this->nullableString($payload['contact_email'] ?? null);
        $contactPhone = $this->nullableString($payload['contact_phone'] ?? null);
        $username = $this->nullableString($payload['username'] ?? null);
        $password = $this->nullableString($payload['password'] ?? null);
        $role = $this->nullableString($payload['role'] ?? 'player') ?? 'player';
        $isActive = 1;

        $sql = sprintf(
            'INSERT INTO `%1$splayers` (club_id, display_name, first_name, last_name, nickname, avatar_url, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('isssssi', $clubId, $displayName, $firstName, $lastName, $nickname, $avatarUrl, $isActive);
        $statement->execute();
        $playerId = (int) $statement->insert_id;
        $statement->close();

        if ($username !== null && $password !== null) {
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            $accountSql = sprintf(
                'INSERT INTO `%1$suser_accounts` (username, password_hash, display_name, role, is_active)
                 VALUES (?, ?, ?, ?, 1)',
                $this->tablePrefix
            );
            $account = $this->connection->prepare($accountSql);
            $account->bind_param('ssss', $username, $passwordHash, $displayName, $role);
            $account->execute();
            $userAccountId = (int) $account->insert_id;
            $account->close();

            $profileSql = sprintf(
                'INSERT INTO `%1$smember_profiles` (user_account_id, player_id, contact_email, contact_phone)
                 VALUES (?, ?, ?, ?)',
                $this->tablePrefix
            );
            $profile = $this->connection->prepare($profileSql);
            $profile->bind_param('iiss', $userAccountId, $playerId, $contactEmail, $contactPhone);
            $profile->execute();
            $profile->close();
        }

        $players = $this->listPlayersByClubId($clubId);

        foreach ($players as $player) {
            if ((int) $player['id'] === $playerId) {
                return $player;
            }
        }

        return [];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listKiosksByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT id, code, name, board_number, sponsor_label, sponsor_logo_url, scoring_mode,
                    CASE WHEN pairing_token_hash IS NULL OR pairing_token_hash = "" THEN 0 ELSE 1 END AS is_paired,
                    paired_device_name, paired_at, is_active, last_seen_at
             FROM `%1$skiosks`
             WHERE club_id = ?
             ORDER BY board_number ASC, name ASC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function createKiosk(int $clubId, array $payload): array
    {
        $code = trim((string) ($payload['code'] ?? ''));
        $name = trim((string) ($payload['name'] ?? $code));
        $boardNumber = (int) ($payload['board_number'] ?? 0);
        $sponsorLabel = $this->nullableString($payload['sponsor_label'] ?? null);
        $sponsorLogoUrl = $this->nullableString($payload['sponsor_logo_url'] ?? null);
        $scoringMode = $this->normalizeScoringMode($payload['scoring_mode'] ?? null);
        $isActive = 1;

        $sql = sprintf(
            'INSERT INTO `%1$skiosks` (club_id, code, name, board_number, sponsor_label, sponsor_logo_url, scoring_mode, pairing_token_hash, paired_device_name, paired_at, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ississsi', $clubId, $code, $name, $boardNumber, $sponsorLabel, $sponsorLogoUrl, $scoringMode, $isActive);
        $statement->execute();
        $kioskId = (int) $statement->insert_id;
        $statement->close();

        return $this->findKioskById($clubId, $kioskId) ?? [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|null
     */
    public function updateKiosk(int $clubId, int $kioskId, array $payload): ?array
    {
        $existing = $this->findKioskById($clubId, $kioskId);

        if ($existing === null) {
            return null;
        }

        $code = trim((string) ($payload['code'] ?? $existing['code']));
        $name = trim((string) ($payload['name'] ?? $existing['name']));
        $boardNumber = isset($payload['board_number']) ? (int) $payload['board_number'] : (int) $existing['board_number'];
        $sponsorLabel = array_key_exists('sponsor_label', $payload)
            ? $this->nullableString($payload['sponsor_label'])
            : $this->nullableString($existing['sponsor_label'] ?? null);
        $sponsorLogoUrl = array_key_exists('sponsor_logo_url', $payload)
            ? $this->nullableString($payload['sponsor_logo_url'])
            : $this->nullableString($existing['sponsor_logo_url'] ?? null);
        $scoringMode = $this->normalizeScoringMode($payload['scoring_mode'] ?? $existing['scoring_mode'] ?? null);
        $isActive = isset($payload['is_active']) ? ((int) $payload['is_active'] === 1 ? 1 : 0) : (int) $existing['is_active'];

        $sql = sprintf(
            'UPDATE `%1$skiosks`
             SET code = ?, name = ?, board_number = ?, sponsor_label = ?, sponsor_logo_url = ?, scoring_mode = ?, is_active = ?
             WHERE id = ? AND club_id = ?',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param(
            'ssisssiii',
            $code,
            $name,
            $boardNumber,
            $sponsorLabel,
            $sponsorLogoUrl,
            $scoringMode,
            $isActive,
            $kioskId,
            $clubId
        );
        $statement->execute();
        $statement->close();

        return $this->findKioskById($clubId, $kioskId);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function resetKioskPairing(int $clubId, int $kioskId): ?array
    {
        $existing = $this->findKioskById($clubId, $kioskId);

        if ($existing === null) {
            return null;
        }

        $sql = sprintf(
            'UPDATE `%1$skiosks`
             SET pairing_token_hash = NULL, paired_device_name = NULL, paired_at = NULL
             WHERE id = ? AND club_id = ?',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $kioskId, $clubId);
        $statement->execute();
        $statement->close();

        return $this->findKioskById($clubId, $kioskId);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listTournamentSummaries(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                t.id,
                t.name,
                t.slug,
                t.provider_system,
                t.status,
                t.start_at,
                t.end_at,
                COUNT(DISTINCT tp.id) AS registration_count,
                COUNT(DISTINCT m.id) AS match_count,
                COUNT(DISTINCT CASE WHEN m.status = "completed" THEN m.id END) AS completed_match_count
             FROM `%1$stournaments` t
             LEFT JOIN `%1$stournament_players` tp ON tp.tournament_id = t.id AND tp.status <> "withdrawn"
             LEFT JOIN `%1$smatches` m ON m.tournament_id = t.id
             WHERE t.club_id = ?
             GROUP BY t.id, t.name, t.slug, t.provider_system, t.status, t.start_at, t.end_at
             ORDER BY COALESCE(t.start_at, "2999-12-31 23:59:59") ASC, t.id DESC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function listRecentMatches(int $clubId): array
    {
        $sql = sprintf(
            'SELECT
                m.id,
                m.status,
                m.round_label,
                m.bracket_label,
                m.starts_at,
                m.finished_at,
                t.id AS tournament_id,
                t.name AS tournament_name,
                k.code AS kiosk_code,
                k.board_number,
                pa.display_name AS player_a_name,
                pb.display_name AS player_b_name,
                pw.display_name AS winner_name
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             LEFT JOIN `%1$splayers` pw ON pw.id = m.winner_player_id
             LEFT JOIN `%1$skiosks` k ON k.id = m.kiosk_id
             WHERE t.club_id = ?
             ORDER BY COALESCE(m.finished_at, m.starts_at, m.id) DESC
             LIMIT 12',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return $rows;
    }

    private function slugify(string $value): string
    {
        $value = trim($value);
        $value = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value) ?: $value;
        $value = strtolower($value);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? 'club';
        $value = trim($value, '-');

        return $value !== '' ? substr($value, 0, 150) : 'club';
    }

    private function nullableString(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $trimmed = trim($value);
        return $trimmed !== '' ? $trimmed : null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findKioskById(int $clubId, int $kioskId): ?array
    {
        $sql = sprintf(
            'SELECT id, code, name, board_number, sponsor_label, sponsor_logo_url, scoring_mode,
                    CASE WHEN pairing_token_hash IS NULL OR pairing_token_hash = "" THEN 0 ELSE 1 END AS is_paired,
                    paired_device_name, paired_at, is_active, last_seen_at
             FROM `%1$skiosks`
             WHERE id = ? AND club_id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $kioskId, $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    private function normalizeScoringMode(mixed $value): string
    {
        return is_string($value) && trim($value) === 'scolia' ? 'scolia' : 'manual';
    }
}
