<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use InvalidArgumentException;
use JsonException;
use RuntimeException;
use Throwable;

final class BackendV2ApiClient
{
    /** @var callable(string,string,array<int,string>,?string,int,int): array{status:int,body:string} */
    private $transport;

    /**
     * @param null|callable(string,string,array<int,string>,?string,int,int): array{status:int,body:string} $transport
     */
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $internalToken = '',
        ?callable $transport = null,
        private readonly int $connectTimeoutMs = 1500,
        private readonly int $totalTimeoutMs = 7000
    ) {
        if (!self::isStrictHttpsBaseUrl($baseUrl)) {
            throw new InvalidArgumentException('Backend-v2 base URL must be a credential-free HTTPS URL.');
        }
        if ($connectTimeoutMs < 1 || $totalTimeoutMs < $connectTimeoutMs || $totalTimeoutMs > 15000) {
            throw new InvalidArgumentException('Backend-v2 API timeouts are invalid.');
        }
        $this->transport = $transport ?? self::defaultTransport(...);
    }

    /**
     * @param array<string,mixed>|null $payload
     * @param array<string,string> $forwardHeaders
     * @return array{status:int,payload:array<string,mixed>}
     */
    public function request(string $method, string $path, ?array $payload = null, array $forwardHeaders = []): array
    {
        $method = strtoupper(trim($method));
        if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            throw new InvalidArgumentException('Unsupported backend-v2 API method.');
        }
        if (preg_match('#^/v1(?:/|$)#', $path) !== 1) {
            throw new InvalidArgumentException('Backend-v2 public API path must start with /v1.');
        }

        $body = null;
        if ($payload !== null) {
            try {
                $body = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            } catch (JsonException $error) {
                throw new InvalidArgumentException('Backend-v2 API payload is not JSON encodable.', 0, $error);
            }
        }

        $headers = ['accept: application/json'];
        if ($body !== null) $headers[] = 'content-type: application/json';
        if (trim($this->internalToken) !== '') {
            $headers[] = 'x-bd-backend-v2-token: ' . trim($this->internalToken);
        }
        foreach ($forwardHeaders as $name => $value) {
            $name = strtolower(trim($name));
            $value = trim($value);
            if ($value === '') continue;
            if (!in_array($name, ['authorization', 'x-kiosk-pairing-token', 'x-scolia-bridge-secret'], true)) continue;
            $headers[] = $name . ': ' . $value;
        }

        $transport = $this->transport;
        try {
            $response = $transport(
                $method,
                rtrim($this->baseUrl, '/') . $path,
                $headers,
                $body,
                $this->connectTimeoutMs,
                $this->totalTimeoutMs
            );
        } catch (Throwable $error) {
            throw new BackendV2ApiAttemptException(
                'Backend-v2 API outcome is unknown after transport failure.',
                null,
                'backend_v2_transport_failure',
                $error
            );
        }

        $status = (int) ($response['status'] ?? 0);
        $raw = (string) ($response['body'] ?? '');
        try {
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            throw new BackendV2ApiAttemptException(
                'Backend-v2 returned invalid JSON after an API attempt.',
                $status > 0 ? $status : null,
                'backend_v2_invalid_response',
                $error
            );
        }
        if (!is_array($decoded)) {
            throw new BackendV2ApiAttemptException(
                'Backend-v2 returned a non-object response after an API attempt.',
                $status > 0 ? $status : null,
                'backend_v2_invalid_response'
            );
        }

        return ['status' => $status, 'payload' => $decoded];
    }

    private static function isStrictHttpsBaseUrl(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || filter_var($value, FILTER_VALIDATE_URL) === false) return false;
        $parts = parse_url($value);
        return is_array($parts)
            && strtolower((string) ($parts['scheme'] ?? '')) === 'https'
            && trim((string) ($parts['host'] ?? '')) !== ''
            && !isset($parts['user'])
            && !isset($parts['pass'])
            && !isset($parts['fragment']);
    }

    /**
     * @param array<int,string> $headers
     * @return array{status:int,body:string}
     */
    private static function defaultTransport(
        string $method,
        string $url,
        array $headers,
        ?string $body,
        int $connectTimeoutMs,
        int $totalTimeoutMs
    ): array {
        $curl = curl_init($url);
        if ($curl === false) throw new RuntimeException('Could not initialize backend-v2 HTTP transport.');
        try {
            $options = [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT_MS => $connectTimeoutMs,
                CURLOPT_TIMEOUT_MS => $totalTimeoutMs,
                CURLOPT_FOLLOWLOCATION => false,
            ];
            if ($body !== null) $options[CURLOPT_POSTFIELDS] = $body;
            curl_setopt_array($curl, $options);
            $responseBody = curl_exec($curl);
            if ($responseBody === false) {
                throw new RuntimeException('Backend-v2 HTTP transport failed: ' . curl_error($curl));
            }
            return [
                'status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
                'body' => (string) $responseBody,
            ];
        } finally {
            curl_close($curl);
        }
    }
}
