<?php

declare(strict_types=1);

final class DartsAtlasHttpClient
{
    public function __construct(
        private string $baseUrl = 'https://www.dartsatlas.com',
        private string $userAgent = 'BlindleiaDartklubb-Live/1.0 (+https://dart.ingenting.org)',
        private int $connectTimeoutSeconds = 3,
        private int $timeoutSeconds = 10
    ) {
        $this->baseUrl = rtrim($this->baseUrl, '/');
    }

    /** @return array{url:string,status:int,body:string,etag:?string,last_modified:?string} */
    public function get(string $pathOrUrl, bool $optional = false): array
    {
        $url = $this->normaliseUrl($pathOrUrl);
        $headers = [];
        $curl = curl_init($url);
        if ($curl === false) {
            throw new RuntimeException('Could not initialise cURL.');
        }

        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeoutSeconds,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_USERAGENT => $this->userAgent,
            CURLOPT_HTTPHEADER => [
                'Accept: text/html,application/xhtml+xml',
                'Accept-Language: no,en;q=0.8',
                'Cache-Control: no-cache',
            ],
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);

        $body = curl_exec($curl);
        $error = curl_error($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $effectiveUrl = (string) curl_getinfo($curl, CURLINFO_EFFECTIVE_URL);
        curl_close($curl);

        if ($body === false) {
            if ($optional) {
                return $this->emptyResponse($url, 0);
            }
            throw new RuntimeException("Darts Atlas request failed for {$url}: {$error}");
        }

        if ($status >= 400) {
            if ($optional && in_array($status, [404, 410], true)) {
                return $this->emptyResponse($effectiveUrl ?: $url, $status, $headers);
            }
            throw new RuntimeException("Darts Atlas returned HTTP {$status} for {$url}");
        }

        return [
            'url' => $effectiveUrl ?: $url,
            'status' => $status,
            'body' => (string) $body,
            'etag' => $headers['etag'] ?? null,
            'last_modified' => $headers['last-modified'] ?? null,
        ];
    }

    private function normaliseUrl(string $pathOrUrl): string
    {
        if (preg_match('~^https?://~i', $pathOrUrl)) {
            $host = strtolower((string) parse_url($pathOrUrl, PHP_URL_HOST));
            if (!in_array($host, ['dartsatlas.com', 'www.dartsatlas.com'], true)) {
                throw new InvalidArgumentException('Darts Atlas adapter refuses external hosts.');
            }
            return $pathOrUrl;
        }
        return $this->baseUrl . '/' . ltrim($pathOrUrl, '/');
    }

    /** @param array<string,string> $headers */
    private function emptyResponse(string $url, int $status, array $headers = []): array
    {
        return [
            'url' => $url,
            'status' => $status,
            'body' => '',
            'etag' => $headers['etag'] ?? null,
            'last_modified' => $headers['last-modified'] ?? null,
        ];
    }
}
