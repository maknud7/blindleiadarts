<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use mysqli;
use Throwable;

final class MembershipDatabase
{
    private ?mysqli $connection = null;
    private bool $resolved = false;
    private string $source = 'unavailable';

    public function __construct(
        private readonly Config $config,
        private readonly Database $primaryDatabase,
        private readonly string $membersTable = 'medlemmer',
    ) {}

    public function connection(): ?mysqli
    {
        if ($this->resolved) {
            return $this->connection;
        }

        $this->resolved = true;
        $sqlconnect = $this->loadSqlconnectConnection();

        if ($sqlconnect instanceof mysqli) {
            $this->connection = $sqlconnect;
            $this->source = 'shared_admin_sqlconnect';
            return $this->connection;
        }

        $this->source = 'unavailable';
        return null;
    }

    /**
     * @return array<int, array{id:int,navn:string}>
     */
    public function listMembers(): array
    {
        $connection = $this->connection();
        if (!$connection instanceof mysqli || !preg_match('/^[A-Za-z0-9_]+$/', $this->membersTable)) {
            return [];
        }

        try {
            $table = $this->membersTable;
            $result = $connection->query("SELECT id, navn FROM `{$table}` ORDER BY navn ASC, id ASC");
            $items = [];
            while ($row = $result->fetch_assoc()) {
                $items[] = [
                    'id' => (int) $row['id'],
                    'navn' => (string) $row['navn'],
                ];
            }
            $result->free();
            return $items;
        } catch (Throwable) {
            return [];
        }
    }

    /** @return array{id:int,navn:string}|null */
    public function findMemberById(int $memberId): ?array
    {
        if ($memberId <= 0) {
            return null;
        }

        $connection = $this->connection();
        if (!$connection instanceof mysqli || !preg_match('/^[A-Za-z0-9_]+$/', $this->membersTable)) {
            return null;
        }

        try {
            $table = $this->membersTable;
            $statement = $connection->prepare("SELECT id, navn FROM `{$table}` WHERE id = ? LIMIT 1");
            $statement->bind_param('i', $memberId);
            $statement->execute();
            $row = $statement->get_result()->fetch_assoc() ?: null;
            $statement->close();

            if ($row === null) {
                return null;
            }

            return [
                'id' => (int) $row['id'],
                'navn' => (string) $row['navn'],
            ];
        } catch (Throwable) {
            return null;
        }
    }

    /**
     * DartsAtlasRepository reads member names through the primary mysqli session.
     * The authoritative registry remains the existing admin database opened by the
     * shared sqlconnect.php. Only id+navn are mirrored into a TEMPORARY session table.
     */
    public function prepareRepositoryBridge(): string
    {
        $primary = $this->primaryDatabase->connection();

        if (!preg_match('/^[A-Za-z0-9_]+$/', $this->membersTable)) {
            return 'unavailable';
        }

        $source = $this->connection();
        $table = $this->membersTable;

        $primary->query(
            "CREATE TEMPORARY TABLE IF NOT EXISTS `{$table}` (
                `id` BIGINT UNSIGNED NOT NULL,
                `navn` VARCHAR(255) NOT NULL,
                PRIMARY KEY (`id`),
                KEY `idx_temp_members_name` (`navn`)
            ) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
        $primary->query("TRUNCATE TABLE `{$table}`");

        if (!$source instanceof mysqli) {
            $this->source = 'unavailable';
            return $this->source;
        }

        try {
            $result = $source->query("SELECT id, navn FROM `{$table}` ORDER BY id");
            $insert = $primary->prepare("INSERT INTO `{$table}` (id, navn) VALUES (?, ?)");
            while ($row = $result->fetch_assoc()) {
                $id = (int) $row['id'];
                $name = (string) $row['navn'];
                $insert->bind_param('is', $id, $name);
                $insert->execute();
            }
            $insert->close();
            $result->free();
            $this->source = 'shared_admin_sqlconnect';
        } catch (Throwable) {
            $this->source = 'unavailable';
        }

        return $this->source;
    }

    public function source(): string
    {
        $this->connection();
        return $this->source;
    }

    public function configured(): bool
    {
        return is_file($this->config->membersSqlconnectPath());
    }

    private function loadSqlconnectConnection(): ?mysqli
    {
        $path = $this->config->membersSqlconnectPath();
        if ($path === '' || !is_file($path)) {
            return null;
        }

        try {
            if (!defined('NO_LAYOUT')) {
                define('NO_LAYOUT', true);
            }

            $loader = static function (string $file): ?mysqli {
                $conn = null;
                $mysqli = null;
                $bufferLevel = ob_get_level();
                ob_start();
                try {
                    $returned = require $file;
                } finally {
                    while (ob_get_level() > $bufferLevel) {
                        ob_end_clean();
                    }
                }

                if ($conn instanceof mysqli) {
                    return $conn;
                }
                if ($mysqli instanceof mysqli) {
                    return $mysqli;
                }
                return $returned instanceof mysqli ? $returned : null;
            };

            $connection = $loader($path);
            if (!$connection instanceof mysqli) {
                return null;
            }

            $connection->set_charset('utf8mb4');
            if (!$this->tableExists($connection, $this->membersTable)) {
                return null;
            }

            return $connection;
        } catch (Throwable) {
            return null;
        }
    }

    private function tableExists(mysqli $connection, string $table): bool
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
            return false;
        }

        $statement = $connection->prepare(
            'SELECT COUNT(*) AS cnt FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
        );
        $statement->bind_param('s', $table);
        $statement->execute();
        $exists = (int) ($statement->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
        $statement->close();
        return $exists;
    }
}
