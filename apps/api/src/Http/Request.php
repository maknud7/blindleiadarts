<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Http;

final class Request
{
    private string $method;
    private string $path;
    private string $rawBody;

    private function __construct(string $method, string $path, string $rawBody)
    {
        $this->method = strtoupper($method);
        $this->path = $path;
        $this->rawBody = $rawBody;
    }

    public static function fromGlobals(): self
    {
        $requestUri = $_SERVER['REQUEST_URI'] ?? '/';
        $scriptName = $_SERVER['SCRIPT_NAME'] ?? '';

        $uriPath = parse_url($requestUri, PHP_URL_PATH) ?: '/';
        $basePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');

        if ($basePath !== '' && $basePath !== '.' && str_starts_with($uriPath, $basePath)) {
            $uriPath = substr($uriPath, strlen($basePath));
        }

        if ($uriPath === false || $uriPath === '') {
            $uriPath = '/';
        }

        $rawBody = file_get_contents('php://input');

        return new self(
            $_SERVER['REQUEST_METHOD'] ?? 'GET',
            $uriPath,
            is_string($rawBody) ? $rawBody : ''
        );
    }

    public function method(): string
    {
        return $this->method;
    }

    public function path(): string
    {
        return $this->path;
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonBody(): array
    {
        if ($this->rawBody === '') {
            return [];
        }

        $decoded = json_decode($this->rawBody, true);
        return is_array($decoded) ? $decoded : [];
    }

    public function bearerToken(): ?string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['Authorization'] ?? null;

        if (!is_string($header) || !str_starts_with($header, 'Bearer ')) {
            return null;
        }

        $token = trim(substr($header, 7));
        return $token !== '' ? $token : null;
    }
}
