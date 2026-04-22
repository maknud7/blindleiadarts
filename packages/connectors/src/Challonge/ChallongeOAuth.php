<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Challonge;

final class ChallongeOAuth
{
    private ChallongeConfig $config;

    public function __construct(ChallongeConfig $config)
    {
        $this->config = $config;
    }

    /**
     * @param array<int, string> $scopes
     */
    public function buildAuthorizationUrl(string $redirectUri, array $scopes = [], ?string $communityId = null, ?string $state = null): string
    {
        $scopeList = $scopes !== [] ? $scopes : $this->config->defaultScopes();

        $query = [
            'client_id' => $this->config->clientId(),
            'redirect_uri' => $redirectUri,
            'response_type' => 'code',
            'scope' => implode(' ', $scopeList),
        ];

        if ($communityId !== null && $communityId !== '') {
            $query['community_id'] = $communityId;
        }

        if ($state !== null && $state !== '') {
            $query['state'] = $state;
        }

        return $this->config->oauthAuthorizeUrl() . '?' . http_build_query($query);
    }
}
