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

        if ($this->config->membersDbConfigured()) {
            try {
                $settings = $this->config->membersDb();
                $connection = new mysqli(
                    $settings['host'],
                    $settings['username'],
                    $settings['password'],
                    $settings['database'],
                    $settings['port'],
                );
                $connection->set_charset('utf8mb4');
                if ($this->tableExists($connection, $this->membersTable)) {
                    $this->source = 'separate_database';
                    $this->connection = $connection;
                    return $this->connection;
                }
                $connection->close();
            } catch (Throwable) {
                // Member matching is optional for the core DartsAtlas import.
            }
        }

        try {
            $primary = $this->primaryDatabase->connection();
            if ($this->tableExists($primary, $this->membersTable)) {
                $this->source = 'primary_database';
                $this->connection = $primary;
                return $this->connection;
            }
        } catch (Throwable) {
            // Primary DB failures are handled through the normal database path.
        }

        $this->source = 'unavailable';
        return null;
    }

    /**
     * DartsAtlasRepository historically reads the members table through the primary mysqli session.
     * When the real registry lives in a separate database, expose only id+navn as a TEMPORARY
     * session table. Nothing is persisted or copied into the dart schema.
     */
    public function prepareRepositoryBridge(): string
    {
        $primary = $this->primaryDatabase->connection();
        if ($this->tableExists($primary, $this->membersTable)) {
            $this->source = 'primary_database';
            return $this->source;
        }

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
            $this->source = 'separate_database';
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
        return $this->config->membersDbConfigured();
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
