<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Service\BackendV2ApiAttemptException;
use Blindleia\Dartkiosk\Api\Service\BackendV2ApiClient;
use Blindleia\Dartkiosk\Api\Support\Config;
use InvalidArgumentException;
use Throwable;

/**
 * Same-origin activity front door. Routing is selected before dispatch and a
 * Node attempt never falls through to the legacy PHP activity application.
 */
final class BackendV2ActivityProxyApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $method = $request->method();
        $path = '/' . trim($request->path(), '/');
        if (!$this->handles($method, $path)) return false;

        $config = Config::load($this->rootPath);
        if ($config->backendV2ActivityRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;
            $body = $method === 'POST' ? $request->jsonBody() : null;
            $targetPath = $this->targetPath($path, (string) ($_SERVER['QUERY_STRING'] ?? ''));
            $result = $client->request($method, $targetPath, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: activity');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_activity_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the activity request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: activity');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 activity request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: activity');
            JsonResponse::error(503, 'backend_v2_activity_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: activity');
            JsonResponse::error(500, 'backend_v2_activity_proxy_failed', 'Activity proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);
        if ($method === 'POST' && $path === '/v1/activity') return true;
        if ($method === 'GET' && $path === '/v1/activity/session') return true;
        if ($method === 'GET' && $path === '/v1/platform/activity') return true;
        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/activity$#', $path) === 1) return true;
        return false;
    }

    public function targetPath(string $path, string $queryString): string
    {
        $isSummary = $path === '/v1/platform/activity'
            || preg_match('#^/v1/clubs/\d+/activity$#', $path) === 1;
        if (!$isSummary || $queryString === '') return $path;
        $parsed = [];
        parse_str($queryString, $parsed);
        $days = $parsed['days'] ?? null;
        if (!is_scalar($days) || trim((string) $days) === '') return $path;
        return $path . '?days=' . rawurlencode(trim((string) $days));
    }
}
