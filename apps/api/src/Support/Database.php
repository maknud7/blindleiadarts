<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use mysqli;
use RuntimeException;

final class Database
{
    private ?Config $config;
    private ?mysqli $connection = null;
    private ?string $tablePrefixOverride = null;

    public function __construct(Config $config)
    {
        $this->config = $config;
    }

    /**
     * Reuse an already-open migration/maintenance connection without opening a second
     * hosted DB connection. Runtime code should keep using the Config constructor.
     */
    public static function fromConnection(mysqli $connection, string $tablePrefix): self
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $tablePrefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }

        $database = new selfWithoutConfig();
        $database->connection = $connection;
        $database->tablePrefixOverride = $tablePrefix;
        return $database;
    }

    private static function newWithoutConfig(): self
    {
        $reflection = new \ReflectionClass(self::class);
        /** @var self $database */
        $database = $reflection->newInstanceWithoutConstructor();
        $database->config = null;
        $database->connection = null;
        $database->tablePrefixOverride = null;
        return $database;
    }

    public function connection(): mysqli
    {
        if ($this->connection instanceof mysqli) {
            return $this->connection;
        }
        if (!$this->config instanceof Config) {
            throw new RuntimeException('Database configuration is unavailable.');
        }

        $connection = new mysqli(
            $this->config->dbHost(),
            $this->config->dbUsername(),
            $this->config->dbPassword(),
            $this->config->dbName(),
            $this->config->dbPort()
        );

        $connection->set_charset('utf8mb4');
        $this->connection = $connection;

        return $this->connection;
    }

    public function ping(): bool
    {
        return $this->connection()->ping();
    }

    public function tablePrefix(): string
    {
        if ($this->tablePrefixOverride !== null) {
            return $this->tablePrefixOverride;
        }
        if (!$this->config instanceof Config) {
            throw new RuntimeException('Database table prefix is unavailable.');
        }
        return $this->config->dbTablePrefix();
    }

    public function identityTablePrefix(): string
    {
        if (!$this->config instanceof Config) {
            return $this->tablePrefix();
        }
        return $this->config->identityTablePrefix();
    }

    /**
     * Physical equipment and integration master data are canonical across
     * environments. TEST runtime data can therefore remain isolated while both
     * TEST and PROD edit the same physical board/Scolia configuration.
     */
    public function hardwareTablePrefix(): string
    {
        if (!$this->config instanceof Config) {
            return $this->tablePrefix();
        }
        return $this->config->hardwareTablePrefix();
    }
}
