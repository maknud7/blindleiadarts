<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Challonge;

use RuntimeException;

final class ChallongeApiClient
{
    private ChallongeConfig $config;

    public function __construct(ChallongeConfig $config)
    {
        $this->config = $config;
    }

    /**
     * @return array<string, mixed>
     */
    public function get(string $path, string $accessToken): array
    {
        return $this->request('GET', $path, $accessToken);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function put(string $path, string $accessToken, array $payload): array
    {
        return $this->request('PUT', $path, $accessToken, $payload);
    }

    /**
     * @param array<string, mixed>|null $payload
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, string $accessToken, ?array $payload = null): array
    {
        if (!function_exists('curl_init')) {
            throw new RuntimeException('cURL extension is required for Challonge API requests.');
        }

        $url = $this->config->apiBaseUrl() . '/' . ltrim($path, '/');
        $headers = [
            'Accept: application/json',
            'Content-Type: application/vnd.api+json',
            'Authorization-Type: v2',
            'Authorization: Bearer ' . $accessToken,
        ];

        $handle = curl_init($url);

        if ($handle === false) {
            throw new RuntimeException('Failed to initialize cURL.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_CUSTOMREQUEST, $method);
        curl_setopt($handle, CURLOPT_HTTPHEADER, $headers);

        if ($payload !== null) {
            $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            curl_setopt($handle, CURLOPT_HTTPHEADER, $headers);
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }

        $responseBody = curl_exec($handle);
        $statusCode = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);

        if ($responseBody === false) {
            $error = curl_error($handle);
            curl_close($handle);
            throw new RuntimeException('Challonge request failed: ' . $error);
        }

        curl_close($handle);

        $decoded = json_decode($responseBody, true);

        if (!is_array($decoded)) {
            throw new RuntimeException('Challonge returned a non-JSON response.');
        }

        if ($statusCode >= 400) {
            throw new RuntimeException('Challonge returned HTTP ' . $statusCode . '.');
        }

        return $decoded;
    }
}
