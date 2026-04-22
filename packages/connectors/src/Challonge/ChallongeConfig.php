<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Challonge;

final class ChallongeConfig
{
    private string $apiBaseUrl;
    private string $oauthAuthorizeUrl;
    private string $oauthTokenUrl;
    private string $clientId;
    private string $clientSecret;

    /**
     * @var array<int, string>
     */
    private array $defaultScopes;

    /**
     * @param array<int, string> $defaultScopes
     */
    public function __construct(
        string $apiBaseUrl,
        string $oauthAuthorizeUrl,
        string $oauthTokenUrl,
        string $clientId,
        string $clientSecret,
        array $defaultScopes
    ) {
        $this->apiBaseUrl = rtrim($apiBaseUrl, '/');
        $this->oauthAuthorizeUrl = $oauthAuthorizeUrl;
        $this->oauthTokenUrl = $oauthTokenUrl;
        $this->clientId = $clientId;
        $this->clientSecret = $clientSecret;
        $this->defaultScopes = array_values(array_filter($defaultScopes));
    }

    public function apiBaseUrl(): string
    {
        return $this->apiBaseUrl;
    }

    public function oauthAuthorizeUrl(): string
    {
        return $this->oauthAuthorizeUrl;
    }

    public function oauthTokenUrl(): string
    {
        return $this->oauthTokenUrl;
    }

    public function clientId(): string
    {
        return $this->clientId;
    }

    public function clientSecret(): string
    {
        return $this->clientSecret;
    }

    /**
     * @return array<int, string>
     */
    public function defaultScopes(): array
    {
        return $this->defaultScopes;
    }

    public function isConfigured(): bool
    {
        return $this->clientId !== '' && $this->clientSecret !== '';
    }
}
