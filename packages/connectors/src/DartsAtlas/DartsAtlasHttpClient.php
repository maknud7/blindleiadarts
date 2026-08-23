<?php

declare(strict_types=1);

final class DartsAtlasHttpResponse
{
    public function __construct(
        public readonly string $url,
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = []
    ) {}
}

final class DartsAtlasHttpClient
{
    private string $baseUrl;

    public function __construct(
        string $baseUrl = 'https://www.dartsatlas.com',
        private readonly int $connectTimeoutSeconds = 4,
        private readonly int $timeoutSeconds = 10
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
        $parts = parse_url($this->baseUrl);
        if (($parts['scheme'] ?? null) !== 'https' || empty($parts['host'])) {
            throw new InvalidArgumentException('DartsAtlas base URL must be an HTTPS URL.');
        }
    }

    public function get(string $pathOrUrl): DartsAtlasHttpResponse
    {
        $url = $this->normaliseUrl($pathOrUrl);

        if (function_exists('curl_init')) {
            return $this->getWithCurl($url);
        }

        return $this->getWithStreams($url);
    }

    private function normaliseUrl(string $pathOrUrl): string
    {
        if (str_starts_with($pathOrUrl, '/')) {
            return $this->baseUrl . $pathOrUrl;
        }

        $candidate = parse_url($pathOrUrl);
        $base = parse_url($this->baseUrl);
        if (
            ($candidate['scheme'] ?? null) !== ($base['scheme'] ?? null)
            || strtolower((string)($candidate['host'] ?? '')) !== strtolower((string)($base['host'] ?? ''))
        ) {
            throw new InvalidArgumentException('DartsAtlas adapter refuses URLs outside configured host.');
        }

        return $pathOrUrl;
    }

    private function getWithCurl(string $url): DartsAtlasHttpResponse
    {
        $headers = [];
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('Unable to initialise cURL.');
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeoutSeconds,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => 'BlindleiaDartklubb-Live/1.0 (+https://dart.ingenting.org)',
            CURLOPT_HTTPHEADER => [
                'Accept: text/html,application/xhtml+xml',
                'Accept-Language: nb-NO,nb;q=0.9,en;q=0.7',
                'Cache-Control: no-cache',
            ],
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
                $length = strlen($line);
                $line = trim($line);
                if ($line === '' || !str_contains($line, ':')) {
                    return $length;
                }
                [$name, $value] = array_map('trim', explode(':', $line, 2));
                $headers[strtolower($name)] = $value;
                return $length;
            },
        ]);

        $body = curl_exec($ch);
        if ($body === false) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new RuntimeException('DartsAtlas request failed: ' . $error);
        }

        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $effectiveUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);

        if ($status < 200 || $status >= 300) {
            throw new RuntimeException(sprintf('DartsAtlas returned HTTP %d for %s', $status, $url));
        }

        return new DartsAtlasHttpResponse($effectiveUrl ?: $url, $status, (string)$body, $headers);
    }

    private function getWithStreams(string $url): DartsAtlasHttpResponse
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => $this->timeoutSeconds,
                'ignore_errors' => true,
                'header' => implode("\r\n", [
                    'User-Agent: BlindleiaDartklubb-Live/1.0 (+https://dart.ingenting.org)',
                    'Accept: text/html,application/xhtml+xml',
                    'Accept-Language: nb-NO,nb;q=0.9,en;q=0.7',
                ]),
            ],
        ]);

        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            throw new RuntimeException('DartsAtlas request failed for ' . $url);
        }

        $status = 0;
        $headers = [];
        foreach (($http_response_header ?? []) as $headerLine) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $headerLine, $match)) {
                $status = (int)$match[1];
            } elseif (str_contains($headerLine, ':')) {
                [$name, $value] = array_map('trim', explode(':', $headerLine, 2));
                $headers[strtolower($name)] = $value;
            }
        }

        if ($status < 200 || $status >= 300) {
            throw new RuntimeException(sprintf('DartsAtlas returned HTTP %d for %s', $status, $url));
        }

        return new DartsAtlasHttpResponse($url, $status, $body, $headers);
    }
}
