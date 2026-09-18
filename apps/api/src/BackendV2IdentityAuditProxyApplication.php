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
 * Same-origin front door for read-only player identity audit and diagnostics.
 * Routing is selected before the legacy database is opened and Node attempts
 * fail closed. The canonical merge mutation deliberately remains PHP-owned.
 */
final class BackendV2IdentityAuditProxyApplication
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
        if ($config->backendV2IdentityAuditRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;

            $targetPath = $this->targetPath($path, (string) ($_SERVER['QUERY_STRING'] ?? ''));
            $body = $method === 'POST' ? $request->jsonBody() : null;
            $result = $client->request($method, $targetPath, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: identity-audit');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_identity_audit_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the identity audit request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: identity-audit');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 identity audit request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: identity-audit');
            JsonResponse::error(503, 'backend_v2_identity_audit_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: identity-audit');
            JsonResponse::error(
                500,
                'backend_v2_identity_audit_proxy_failed',
                'Identity audit proxy failed before a safe response was produced.'
            )->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);
        if ($method === 'GET' && preg_match('#^/v1/player-identities/(?:history|health)$#', $path) === 1) {
            return true;
        }
        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/player-identities/duplicates$#', $path) === 1) {
            return true;
        }
        return $method === 'POST'
            && preg_match('#^/v1/clubs/\d+/player-identities/(?:preview|merge)$#', $path) === 1;
    }

    public function targetPath(string $path, string $queryString): string
    {
        if ($path !== '/v1/player-identities/history') return $path;
        $parsed = [];
        parse_str($queryString, $parsed);
        $limit = isset($parsed['limit']) && is_scalar($parsed['limit']) ? trim((string) $parsed['limit']) : '';
        if ($limit === '' || preg_match('/^-?\d+$/', $limit) !== 1) return $path;
        return $path . '?limit=' . rawurlencode($limit);
    }
}
