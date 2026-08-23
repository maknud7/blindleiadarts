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
                // Member matching is an enhancement. DartsAtlas sync must continue without it.
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
            // Primary DB errors are handled by the caller's normal database path.
        }

        $this->source = 'unavailable';
        $this->connection = null;
        return null;
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
