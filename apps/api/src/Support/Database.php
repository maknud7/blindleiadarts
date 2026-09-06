<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use mysqli;
use RuntimeException;
use Throwable;

final class Database
{
    private ?mysqli $connection = null;
    private ?string $tablePrefixOverride = null;
    private ?DatabaseConnectionGate $connectionGate = null;
    private bool $ownsConnection = false;
    private float $connectionGateWaitMs = 0.0;

    public function __construct(private ?Config $config = null)
    {
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

        $database = new self();
        $database->connection = $connection;
        $database->tablePrefixOverride = $tablePrefix;
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

        $gate = DatabaseConnectionGate::acquire($this->config);
        try {
            $connection = new mysqli(
                $this->config->dbHost(),
                $this->config->dbUsername(),
                $this->config->dbPassword(),
                $this->config->dbName(),
                $this->config->dbPort()
            );
            $connection->set_charset('utf8mb4');
        } catch (Throwable $error) {
            $gate?->release();
            throw $error;
        }

        $this->connection = $connection;
        $this->connectionGate = $gate;
        $this->connectionGateWaitMs = $gate?->waitMs() ?? 0.0;
        $this->ownsConnection = true;

        return $this->connection;
    }

    public function releaseConnection(): void
    {
        if ($this->ownsConnection && $this->connection instanceof mysqli) {
            try {
                $this->connection->close();
            } catch (Throwable) {
            }
        }
        if ($this->ownsConnection) {
            $this->connection = null;
        }
        $this->ownsConnection = false;
        $this->connectionGate?->release();
        $this->connectionGate = null;
    }

    public function connectionGateWaitMs(): float
    {
        return $this->connectionGateWaitMs;
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

    public function __destruct()
    {
        $this->releaseConnection();
    }
}
