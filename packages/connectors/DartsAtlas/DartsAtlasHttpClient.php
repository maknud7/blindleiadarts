<?php

declare(strict_types=1);

final class DartsAtlasHttpResponse
{
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers,
        public readonly string $url,
    ) {}

    public function header(string $name): ?string
    {
        $key = strtolower($name);
        return $this->headers[$key] ?? null;
    }
}

final class DartsAtlasHttpClient
{
    public function __construct(
        private readonly string $userAgent = 'BlindleiaDarts/1.0',
        private readonly int $connectTimeoutSeconds = 5,
        private readonly int $timeoutSeconds = 12,
    ) {}

    public function get(string $url, ?string $etag = null, ?string $lastModified = null): DartsAtlasHttpResponse
    {
        $this->assertAllowedUrl($url);

        $requestHeaders = [
            'Accept: text/html,application/xhtml+xml',
            'Accept-Language: en-GB,en;q=0.8,nb;q=0.6',
        ];
        if ($etag !== null && $etag !== '') {
            $requestHeaders[] = 'If-None-Match: ' . $etag;
        }
        if ($lastModified !== null && $lastModified !== '') {
            $requestHeaders[] = 'If-Modified-Since: ' . $lastModified;
        }

        if (function_exists('curl_init')) {
            return $this->getWithCurl($url, $requestHeaders);
        }

        return $this->getWithStreams($url, $requestHeaders);
    }

    private function getWithCurl(string $url, array $requestHeaders): DartsAtlasHttpResponse
    {
        $headers = [];
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('Could not initialise cURL.');
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeoutSeconds,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_USERAGENT => $this->userAgent,
            CURLOPT_HTTPHEADER => $requestHeaders,
            CURLOPT_ENCODING => '',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
                $length = strlen($line);
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return $length;
            },
        ]);

        $body = curl_exec($ch);
        if ($body === false) {
            $message = curl_error($ch);
            curl_close($ch);
            throw new RuntimeException('DartsAtlas request failed: ' . $message);
        }

        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $effectiveUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);

        if ($status !== 304 && ($status < 200 || $status >= 300)) {
            throw new RuntimeException("DartsAtlas returned HTTP {$status} for {$url}");
        }

        return new DartsAtlasHttpResponse($status, (string) $body, $headers, $effectiveUrl ?: $url);
    }

    private function getWithStreams(string $url, array $requestHeaders): DartsAtlasHttpResponse
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => implode("\r\n", array_merge($requestHeaders, ['User-Agent: ' . $this->userAgent])),
                'timeout' => $this->timeoutSeconds,
                'ignore_errors' => true,
                'follow_location' => 1,
                'max_redirects' => 3,
            ],
        ]);

        $body = @file_get_contents($url, false, $context);
        $responseHeaders = $http_response_header ?? [];
        $status = 0;
        $headers = [];
        foreach ($responseHeaders as $index => $line) {
            if ($index === 0 && preg_match('/\s(\d{3})\s/', $line, $match)) {
                $status = (int) $match[1];
                continue;
            }
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            }
        }

        if ($body === false && $status !== 304) {
            throw new RuntimeException("DartsAtlas request failed for {$url}");
        }
        if ($status !== 304 && ($status < 200 || $status >= 300)) {
            throw new RuntimeException("DartsAtlas returned HTTP {$status} for {$url}");
        }

        return new DartsAtlasHttpResponse($status, $body === false ? '' : $body, $headers, $url);
    }

    private function assertAllowedUrl(string $url): void
    {
        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));

        if ($scheme !== 'https' || !in_array($host, ['www.dartsatlas.com', 'dartsatlas.com'], true)) {
            throw new InvalidArgumentException('Only HTTPS requests to dartsatlas.com are allowed.');
        }
    }
}
