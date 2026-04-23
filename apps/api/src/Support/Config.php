<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeConfig;
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

    public function screenDefaultClubSlug(): string
    {
        return (string) (($this->config['screen']['default_club_slug'] ?? '') ?: '');
    }

    public function realtimeWebsocketUrl(): string
    {
        return (string) (($this->config['realtime']['websocket_url'] ?? '') ?: '');
    }

    public function realtimePublishUrl(): string
    {
        return (string) (($this->config['realtime']['publish_url'] ?? '') ?: '');
    }

    public function realtimePublishSecret(): string
    {
        return (string) (($this->config['realtime']['publish_secret'] ?? '') ?: '');
    }

    public function realtimeEnabled(): bool
    {
        return $this->realtimeWebsocketUrl() !== '';
    }

    public function realtimePublishEnabled(): bool
    {
        return $this->realtimePublishUrl() !== '' && $this->realtimePublishSecret() !== '';
    }

    public function challonge(): ChallongeConfig
    {
        /** @var array<string, mixed> $challonge */
        $challonge = is_array($this->config['challonge'] ?? null) ? $this->config['challonge'] : [];

        /** @var array<int, string> $defaultScopes */
        $defaultScopes = is_array($challonge['default_scopes'] ?? null) ? $challonge['default_scopes'] : [];

        return new ChallongeConfig(
            (string) (($challonge['api_base_url'] ?? 'https://api.challonge.com/v2.1') ?: 'https://api.challonge.com/v2.1'),
            (string) (($challonge['oauth_authorize_url'] ?? 'https://api.challonge.com/oauth/authorize') ?: 'https://api.challonge.com/oauth/authorize'),
            (string) (($challonge['oauth_token_url'] ?? 'https://api.challonge.com/oauth/token') ?: 'https://api.challonge.com/oauth/token'),
            (string) (($challonge['redirect_uri'] ?? '') ?: ''),
            (string) (($challonge['client_id'] ?? '') ?: ''),
            (string) (($challonge['client_secret'] ?? '') ?: ''),
            $defaultScopes
        );
    }
}
