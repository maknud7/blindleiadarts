<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class ScreenRepository
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
    public function listByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT id, club_id, label, access_code, access_token, is_active, last_connected_at, created_at, updated_at
             FROM `%1$sscreen_devices`
             WHERE club_id = ?
             ORDER BY created_at DESC, id DESC',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        /** @var array<int, array<string, mixed>> $rows */
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        return array_map(fn (array $row): array => $this->formatDevice($row), $rows);
    }

    /**
     * @return array<string, mixed>
     */
    public function createForClub(int $clubId, ?string $label = null): array
    {
        $label = $this->normalizeLabel($label);
        $prefix = $this->buildCodePrefix($clubId);

        do {
            $accessCode = $this->generateAccessCode($prefix);
        } while ($this->findByAccessCode($accessCode) !== null);

        do {
            $accessToken = bin2hex(random_bytes(24));
        } while ($this->findByAccessToken($accessToken) !== null);

        $isActive = 1;
        $sql = sprintf(
            'INSERT INTO `%1$sscreen_devices` (club_id, label, access_code, access_token, is_active)
             VALUES (?, ?, ?, ?, ?)',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('isssi', $clubId, $label, $accessCode, $accessToken, $isActive);
        $statement->execute();
        $deviceId = (int) $statement->insert_id;
        $statement->close();

        $device = $this->findById($deviceId);
        return $this->formatDevice($device ?? []);
    }

    /**
     * @return array<string, mixed>|null
     */
    public function connectByCode(string $accessCode): ?array
    {
        $device = $this->findByAccessCode($accessCode);

        if ($device === null || (int) ($device['is_active'] ?? 0) !== 1) {
            return null;
        }

        $this->touch((int) $device['id']);
        $device = $this->findById((int) $device['id']);

        if ($device === null) {
            return null;
        }

        return [
            'device' => $this->formatDevice($device),
            'club' => $this->findClubForDevice((int) $device['id']),
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function resolveByAccessToken(string $accessToken): ?array
    {
        $device = $this->findByAccessToken($accessToken);

        if ($device === null || (int) ($device['is_active'] ?? 0) !== 1) {
            return null;
        }

        $this->touch((int) $device['id']);
        $device = $this->findById((int) $device['id']);

        if ($device === null) {
            return null;
        }

        return [
            'device' => $this->formatDevice($device),
            'club' => $this->findClubForDevice((int) $device['id']),
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findById(int $deviceId): ?array
    {
        $sql = sprintf(
            'SELECT id, club_id, label, access_code, access_token, is_active, last_connected_at, created_at, updated_at
             FROM `%1$sscreen_devices`
             WHERE id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $deviceId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findByAccessCode(string $accessCode): ?array
    {
        $sql = sprintf(
            'SELECT id, club_id, label, access_code, access_token, is_active, last_connected_at, created_at, updated_at
             FROM `%1$sscreen_devices`
             WHERE access_code = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $accessCode);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findByAccessToken(string $accessToken): ?array
    {
        $sql = sprintf(
            'SELECT id, club_id, label, access_code, access_token, is_active, last_connected_at, created_at, updated_at
             FROM `%1$sscreen_devices`
             WHERE access_token = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('s', $accessToken);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findClubForDevice(int $deviceId): ?array
    {
        $sql = sprintf(
            'SELECT c.id, c.name, c.slug, c.logo_url
             FROM `%1$sscreen_devices` sd
             INNER JOIN `%1$sclubs` c ON c.id = sd.club_id
             WHERE sd.id = ?
             LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $deviceId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row;
    }

    private function touch(int $deviceId): void
    {
        $sql = sprintf(
            'UPDATE `%1$sscreen_devices`
             SET last_connected_at = NOW()
             WHERE id = ?',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $deviceId);
        $statement->execute();
        $statement->close();
    }

    private function normalizeLabel(?string $label): string
    {
        $label = trim((string) $label);

        if ($label === '') {
            return 'Venue Screen';
        }

        return substr($label, 0, 150);
    }

    private function generateAccessCode(string $prefix): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $part = '';

        for ($index = 0; $index < 4; $index++) {
            $part .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return sprintf('%s-%s', $prefix, $part);
    }

    /**
     * @param array<string, mixed> $device
     * @return array<string, mixed>
     */
    private function formatDevice(array $device): array
    {
        return [
            'id' => isset($device['id']) ? (int) $device['id'] : null,
            'club_id' => isset($device['club_id']) ? (int) $device['club_id'] : null,
            'label' => $device['label'] ?? null,
            'access_code' => $device['access_code'] ?? null,
            'access_token' => $device['access_token'] ?? null,
            'is_active' => isset($device['is_active']) ? (int) $device['is_active'] : 0,
            'last_connected_at' => $device['last_connected_at'] ?? null,
            'created_at' => $device['created_at'] ?? null,
            'updated_at' => $device['updated_at'] ?? null,
        ];
    }

    private function buildCodePrefix(int $clubId): string
    {
        $sql = sprintf(
            'SELECT slug, name FROM `%1$sclubs` WHERE id = ? LIMIT 1',
            $this->tablePrefix
        );

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $club = $result->fetch_assoc() ?: null;
        $statement->close();

        $reference = strtolower((string) ($club['slug'] ?? $club['name'] ?? 'screen'));
        $reference = preg_replace('/[^a-z0-9]+/', '', $reference) ?? 'screen';
        $reference = strtoupper(substr($reference !== '' ? $reference : 'SCREEN', 0, 4));

        return str_pad($reference, 4, 'X');
    }
}
