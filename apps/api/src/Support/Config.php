<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use Blindleia\Dartkiosk\Connectors\Challonge\ChallongeConfig;
use Blindleia\Dartkiosk\Connectors\DartsAtlas\DartsAtlasConfig;
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

    /** @return array{host:string,port:int,database:string,username:string,password:string} */
    public function membersDb(): array
    {
        $members = is_array($this->config['members_db'] ?? null) ? $this->config['members_db'] : [];
        return [
            'host' => (string) (($members['host'] ?? '') ?: ''),
            'port' => (int) (($members['port'] ?? 3306) ?: 3306),
            'database' => (string) (($members['database'] ?? '') ?: ''),
            'username' => (string) (($members['username'] ?? '') ?: ''),
            'password' => (string) (($members['password'] ?? '') ?: ''),
        ];
    }

    public function membersDbConfigured(): bool
    {
        $members = $this->membersDb();
        return $members['host'] !== '' && $members['database'] !== '' && $members['username'] !== '';
    }

    public function membersSqlconnectPath(): string
    {
        $members = is_array($this->config['members_db'] ?? null) ? $this->config['members_db'] : [];
        $path = trim((string) (($members['sqlconnect_path'] ?? '../sqlconnect.php') ?: ''));
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

    public function dartsAtlas(): DartsAtlasConfig
    {
        /** @var array<string, mixed> $dartsAtlas */
        $dartsAtlas = is_array($this->config['dartsatlas'] ?? null) ? $this->config['dartsatlas'] : [];
        $localSeasonRaw = $dartsAtlas['local_season_id'] ?? null;
        $localSeasonId = ($localSeasonRaw === null || $localSeasonRaw === '') ? null : (int) $localSeasonRaw;

        return new DartsAtlasConfig(
            (string) (($dartsAtlas['season_id'] ?? '') ?: ''),
            (string) (($dartsAtlas['tournament_id'] ?? '') ?: ''),
            (int) (($dartsAtlas['club_id'] ?? 0) ?: 0),
            $localSeasonId,
            (string) (($dartsAtlas['members_table'] ?? 'medlemmer') ?: 'medlemmer'),
            max(5, (int) (($dartsAtlas['poll_interval_seconds'] ?? 8) ?: 8)),
            (string) (($dartsAtlas['user_agent'] ?? 'BlindleiaDarts/1.0') ?: 'BlindleiaDarts/1.0'),
        );
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
