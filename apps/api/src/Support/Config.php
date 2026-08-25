<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeConfig;
use RuntimeException;

final class Config
{
    /** @var array<string, mixed> */
    private array $config;

    /** @param array<string, mixed> $config */
    private function __construct(array $config, private readonly string $rootPath)
    {
        $this->config = $config;
    }

    public static function load(string $rootPath): self
    {
        $rootPath = rtrim($rootPath, '/\\');
        $configPath = $rootPath . '/config.php';
        $fallbackPath = $rootPath . '/config.example.php';

        if (is_file($configPath)) {
            /** @var array<string, mixed> $config */
            $config = require $configPath;
            return new self($config, $rootPath);
        }

        if (is_file($fallbackPath)) {
            /** @var array<string, mixed> $config */
            $config = require $fallbackPath;
            return new self($config, $rootPath);
        }

        throw new RuntimeException('No API configuration file found.');
    }

    public function appEnv(): string { return (string) ($this->config['app_env'] ?? 'unknown'); }
    public function dbHost(): string { return (string) (($this->config['db']['host'] ?? '') ?: ''); }
    public function dbPort(): int { return (int) (($this->config['db']['port'] ?? 3306) ?: 3306); }
    public function dbName(): string { return (string) (($this->config['db']['database'] ?? '') ?: ''); }
    public function dbUsername(): string { return (string) (($this->config['db']['username'] ?? '') ?: ''); }
    public function dbPassword(): string { return (string) (($this->config['db']['password'] ?? '') ?: ''); }
    public function dbTablePrefix(): string { return (string) (($this->config['db']['table_prefix'] ?? '') ?: ''); }

    /**
     * User accounts, sessions and permissions are shared between test and production.
     * Runtime test therefore points at the production identity tables while tournament
     * and scoring data keep their environment-specific prefix. CI may omit this setting
     * to keep destructive smoke tests isolated in bd_test_.
     */
    public function identityTablePrefix(): string
    {
        $configured = trim((string) (($this->config['db']['identity_table_prefix'] ?? '') ?: ''));
        return $configured !== '' ? $configured : $this->dbTablePrefix();
    }

    /**
     * Physical boards are real club equipment and have one canonical registry. Deployed
     * test and production point at the production hardware namespace. The test runtime may
     * still create internal aliases for match foreign keys; those are not board masterdata.
     */
    public function hardwareTablePrefix(): string
    {
        $configured = trim((string) (($this->config['db']['hardware_table_prefix'] ?? '') ?: ''));
        return $configured !== '' ? $configured : $this->dbTablePrefix();
    }

    public function membersSqlconnectPath(): string
    {
        $members = is_array($this->config['members_db'] ?? null) ? $this->config['members_db'] : [];
        $path = trim((string) (($members['sqlconnect_path'] ?? '/home/1/i/ingenting/dart/sqlconnect.php') ?: ''));
        if ($path === '') {
            return '';
        }

        if (str_starts_with($path, '/') || preg_match('/^[A-Za-z]:[\\\\\/]/', $path) === 1) {
            return $path;
        }

        return $this->rootPath . DIRECTORY_SEPARATOR . $path;
    }

    public function screenDefaultClubSlug(): string { return (string) (($this->config['screen']['default_club_slug'] ?? '') ?: ''); }
    public function realtimeWebsocketUrl(): string { return (string) (($this->config['realtime']['websocket_url'] ?? '') ?: ''); }
    public function realtimePublishUrl(): string { return (string) (($this->config['realtime']['publish_url'] ?? '') ?: ''); }
    public function realtimePublishSecret(): string { return (string) (($this->config['realtime']['publish_secret'] ?? '') ?: ''); }
    public function realtimeEnabled(): bool { return $this->realtimeWebsocketUrl() !== ''; }
    public function realtimePublishEnabled(): bool { return $this->realtimePublishUrl() !== '' && $this->realtimePublishSecret() !== ''; }
    public function scoliaBridgeSecret(): string { return (string) (($this->config['scolia']['bridge_secret'] ?? '') ?: ''); }

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