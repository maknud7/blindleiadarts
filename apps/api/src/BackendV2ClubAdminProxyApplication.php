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
 * Same-origin front door for runtime club administration, kiosk bootstrap and
 * isolated runtime reads.
 *
 * TEST may create isolated bd_test_ clubs through backend-v2, resolve the
 * public kiosk pairing code, read active match calls and serve the read-only
 * API health contract from Node. Read routes do not require or mutate shared
 * identity. PROD keeps the legacy PHP owner while club_admin_routing_mode is
 * php.
 *
 * Routing is decided before the legacy Application opens its database
 * connection. Once Node has been attempted the request fails closed and never
 * falls through to PHP.
 */
final class BackendV2ClubAdminProxyApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $method = $request->method();
        $path = '/' . trim($request->path(), '/');
        if (!$this->handles($method, $path)) {
            return false;
        }

        $config = Config::load($this->rootPath);
        if ($config->backendV2ClubAdminRoutingMode() !== 'node') {
            return false;
        }

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) {
                $headers['authorization'] = $authorization;
            }
            $body = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)
                ? $request->jsonBody()
                : null;

            $targetPath = $this->targetPath($path, (string) ($_SERVER['QUERY_STRING'] ?? ''));
            $result = $client->request($method, $targetPath, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: club-admin');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_club_admin_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the club administration request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: club-admin');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 club administration failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: club-admin');
            JsonResponse::error(503, 'backend_v2_club_admin_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: club-admin');
            JsonResponse::error(
                500,
                'backend_v2_club_admin_proxy_failed',
                'Club administration proxy failed before a safe response was produced.'
            )->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);

        if ($method === 'GET' && $path === '/v1/health') {
            return true;
        }

        if ($method === 'GET' && preg_match('#^/v1/clubs/[1-9][0-9]*/match-calls$#', $path) === 1) {
            return true;
        }

        if ($method !== 'POST') {
            return false;
        }

        return in_array($path, [
            '/v1/clubs',
            '/v1/public/kiosk/connect',
        ], true);
    }

    public function targetPath(string $path, string $queryString): string
    {
        if ($path !== '/v1/health') {
            return $path;
        }

        $parsed = [];
        parse_str($queryString, $parsed);
        return (string) ($parsed['deep'] ?? '') === '1'
            ? '/v1/health?deep=1'
            : '/v1/health';
    }
}
