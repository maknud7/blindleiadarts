<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use RuntimeException;

final class Config
{
    /**
     * @var array<string, mixed>
     */
    private array $config;

    /**
     * @param array<string, mixed> $config
     */
    private function __construct(array $config)
    {
        $this->config = $config;
    }

    public static function load(string $rootPath): self
    {
        $configPath = $rootPath . '/config.php';
        $fallbackPath = $rootPath . '/config.example.php';

        if (is_file($configPath)) {
            /** @var array<string, mixed> $config */
            $config = require $configPath;
            return new self($config);
        }

        if (is_file($fallbackPath)) {
            /** @var array<string, mixed> $config */
            $config = require $fallbackPath;
            return new self($config);
        }

        throw new RuntimeException('No API configuration file found.');
    }

    public function appEnv(): string
    {
        return (string) ($this->config['app_env'] ?? 'unknown');
    }

    public function dbHost(): string
    {
        return (string) (($this->config['db']['host'] ?? '') ?: '');
    }

    public function dbPort(): int
    {
        return (int) (($this->config['db']['port'] ?? 3306) ?: 3306);
    }

    public function dbName(): string
    {
        return (string) (($this->config['db']['database'] ?? '') ?: '');
    }

    public function dbUsername(): string
    {
        return (string) (($this->config['db']['username'] ?? '') ?: '');
    }

    public function dbPassword(): string
    {
        return (string) (($this->config['db']['password'] ?? '') ?: '');
    }

    public function dbTablePrefix(): string
    {
        return (string) (($this->config['db']['table_prefix'] ?? '') ?: '');
    }
}
