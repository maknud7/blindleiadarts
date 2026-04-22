<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Http;

final class Request
{
    private string $method;
    private string $path;

    private function __construct(string $method, string $path)
    {
        $this->method = strtoupper($method);
        $this->path = $path;
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

        return new self($_SERVER['REQUEST_METHOD'] ?? 'GET', $uriPath);
    }

    public function method(): string
    {
        return $this->method;
    }

    public function path(): string
    {
        return $this->path;
    }
}
