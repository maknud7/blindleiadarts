<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Challonge;

use RuntimeException;

final class ChallongeOAuthClient
{
    private ChallongeConfig $config;

    public function __construct(ChallongeConfig $config)
    {
        $this->config = $config;
    }

    /**
     * @return array<string, mixed>
     */
    public function exchangeAuthorizationCode(string $code, ?string $redirectUri = null): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('cURL extension is required for Challonge OAuth.');
        }

        $uri = $redirectUri ?: $this->config->redirectUri();

        if ($uri === '') {
            throw new RuntimeException('Challonge redirect URI is not configured.');
        }

        $query = http_build_query([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'client_id' => $this->config->clientId(),
            'client_secret' => $this->config->clientSecret(),
            'redirect_uri' => $uri,
        ]);

        $handle = curl_init($this->config->oauthTokenUrl() . '?' . $query);

        if ($handle === false) {
            throw new RuntimeException('Failed to initialize cURL.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_POST, true);
        curl_setopt($handle, CURLOPT_HTTPHEADER, [
            'Accept: application/json',
        ]);

        $responseBody = curl_exec($handle);
        $statusCode = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);

        if ($responseBody === false) {
            $error = curl_error($handle);
            curl_close($handle);
            throw new RuntimeException('Challonge token request failed: ' . $error);
        }

        curl_close($handle);

        $decoded = json_decode($responseBody, true);

        if (!is_array($decoded)) {
            throw new RuntimeException('Challonge token response was not valid JSON.');
        }

        if ($statusCode >= 400) {
            throw new RuntimeException('Challonge token request returned HTTP ' . $statusCode . '.');
        }

        return $decoded;
    }
}
