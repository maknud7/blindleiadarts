<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use mysqli;

final class Database
{
    private Config $config;
    private ?mysqli $connection = null;

    public function __construct(Config $config)
    {
        $this->config = $config;
    }

    public function connection(): mysqli
    {
        if ($this->connection instanceof mysqli) {
            return $this->connection;
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
        return $this->config->dbTablePrefix();
    }

    public function identityTablePrefix(): string
    {
        return $this->config->identityTablePrefix();
    }

    /**
     * Physical equipment and integration master data are canonical across
     * environments. TEST runtime data can therefore remain isolated while both
     * TEST and PROD edit the same physical board/Scolia configuration.
     */
    public function hardwareTablePrefix(): string
    {
        return $this->config->hardwareTablePrefix();
    }
}
