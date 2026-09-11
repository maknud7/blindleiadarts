<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use InvalidArgumentException;
use JsonException;
use RuntimeException;
use Throwable;

final class BackendV2ScoringClient
{
    /** @var callable(string, array<int,string>, string, int, int): array{status:int,body:string} */
    private $transport;

    /**
     * @param null|callable(string, array<int,string>, string, int, int): array{status:int,body:string} $transport
     */
    public function __construct(
        private readonly string $baseUrl,
        private readonly string $internalToken,
        ?callable $transport = null,
        private readonly int $connectTimeoutMs = 1500,
        private readonly int $totalTimeoutMs = 5000
    ) {
        if (!self::isStrictHttpsBaseUrl($baseUrl)) {
            throw new InvalidArgumentException('Backend-v2 base URL must be a credential-free HTTPS URL.');
        }
        if (trim($internalToken) === '') {
            throw new InvalidArgumentException('Backend-v2 internal token is required.');
        }
        if ($connectTimeoutMs < 1 || $totalTimeoutMs < $connectTimeoutMs || $totalTimeoutMs > 15000) {
            throw new InvalidArgumentException('Backend-v2 timeouts are invalid.');
        }

        $this->transport = $transport ?? self::defaultTransport(...);
    }

    /** @return array<string,mixed> */
    public function startMatch(string $kioskId, string $source): array
    {
        return $this->post('/internal/v1/scoring/start-match', [
            'kiosk_id' => $this->canonicalKioskId($kioskId),
            'source' => $this->canonicalSource($source),
        ]);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function recordVisit(string $kioskId, array $payload, string $source): array
    {
        return $this->post('/internal/v1/scoring/visit', [
            'kiosk_id' => $this->canonicalKioskId($kioskId),
            'source' => $this->canonicalSource($source),
            'payload' => $payload,
        ]);
    }

    /** @return array<string,mixed> */
    public function undoLastVisit(string $kioskId, string $source): array
    {
        return $this->post('/internal/v1/scoring/undo', [
            'kiosk_id' => $this->canonicalKioskId($kioskId),
            'source' => $this->canonicalSource($source),
        ]);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    private function post(string $path, array $payload): array
    {
        try {
            $json = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        } catch (JsonException $error) {
            // Encoding failed before transport; no backend-v2 attempt happened.
            throw new InvalidArgumentException('Backend-v2 scoring payload is not JSON encodable.', 0, $error);
        }

        $transport = $this->transport;
        try {
            $response = $transport(
                rtrim($this->baseUrl, '/') . $path,
                [
                    'content-type: application/json',
                    'accept: application/json',
                    'x-bd-backend-v2-token: ' . $this->internalToken,
                ],
                $json,
                $this->connectTimeoutMs,
                $this->totalTimeoutMs
            );
        } catch (Throwable $error) {
            throw new BackendV2ScoringAttemptException(
                'Backend-v2 scoring outcome is unknown after transport failure.',
                null,
                'backend_v2_transport_failure',
                $error
            );
        }

        $status = (int) ($response['status'] ?? 0);
        $body = (string) ($response['body'] ?? '');
        try {
            $decoded = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            throw new BackendV2ScoringAttemptException(
                'Backend-v2 returned an invalid response after a scoring attempt.',
                $status > 0 ? $status : null,
                'backend_v2_invalid_response',
                $error
            );
        }

        if (!is_array($decoded)) {
            throw new BackendV2ScoringAttemptException(
                'Backend-v2 returned a non-object response after a scoring attempt.',
                $status > 0 ? $status : null,
                'backend_v2_invalid_response'
            );
        }

        if ($status < 200 || $status >= 300 || ($decoded['ok'] ?? null) !== true) {
            $error = is_array($decoded['error'] ?? null) ? $decoded['error'] : [];
            throw new BackendV2ScoringAttemptException(
                (string) (($error['message'] ?? '') ?: 'Backend-v2 rejected or failed the scoring attempt.'),
                $status > 0 ? $status : null,
                (string) (($error['code'] ?? '') ?: 'backend_v2_scoring_failed')
            );
        }

        $result = $decoded['result'] ?? [];
        if (!is_array($result)) {
            throw new BackendV2ScoringAttemptException(
                'Backend-v2 success response is missing its result object.',
                $status,
                'backend_v2_invalid_response'
            );
        }

        return $result;
    }

    private function canonicalKioskId(string $kioskId): string
    {
        if (preg_match('/^[1-9][0-9]*$/D', $kioskId) !== 1) {
            throw new InvalidArgumentException('Kiosk id must be a canonical positive decimal string.');
        }
        return $kioskId;
    }

    private function canonicalSource(string $source): string
    {
        if (!in_array($source, ['manual', 'scolia', 'import', 'api'], true)) {
            throw new InvalidArgumentException('Unsupported backend-v2 scoring source.');
        }
        return $source;
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
        string $url,
        array $headers,
        string $json,
        int $connectTimeoutMs,
        int $totalTimeoutMs
    ): array {
        $curl = curl_init($url);
        if ($curl === false) throw new RuntimeException('Could not initialize backend-v2 HTTP transport.');

        try {
            curl_setopt_array($curl, [
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_POSTFIELDS => $json,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT_MS => $connectTimeoutMs,
                CURLOPT_TIMEOUT_MS => $totalTimeoutMs,
                CURLOPT_FOLLOWLOCATION => false,
            ]);
            $body = curl_exec($curl);
            if ($body === false) {
                throw new RuntimeException('Backend-v2 HTTP transport failed: ' . curl_error($curl));
            }
            return [
                'status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
                'body' => (string) $body,
            ];
        } finally {
            curl_close($curl);
        }
    }
}
