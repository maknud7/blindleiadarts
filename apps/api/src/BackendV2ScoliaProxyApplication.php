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
 * Same-origin front door for Scolia bridge and paired-kiosk runtime cutover.
 *
 * Routing is decided before any mutation. Once Node has been attempted the
 * request always fails closed and never falls through to the legacy PHP Scolia
 * writer, because the remote outcome may already have committed canonical state.
 */
final class BackendV2ScoliaProxyApplication
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
        if ($config->backendV2ScoliaRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $body = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)
                ? $request->jsonBody()
                : null;
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;
            $pairingToken = $request->header('x-kiosk-pairing-token');
            if ($pairingToken !== null) $headers['x-kiosk-pairing-token'] = $pairingToken;
            $bridgeSecret = $request->header('x-scolia-bridge-secret');
            if ($bridgeSecret !== null) $headers['x-scolia-bridge-secret'] = $bridgeSecret;

            $result = $client->request($method, $path, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: scolia');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_scolia_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the Scolia request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: scolia');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 Scolia request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: scolia');
            JsonResponse::error(503, 'backend_v2_scolia_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: scolia');
            JsonResponse::error(500, 'backend_v2_scolia_proxy_failed', 'Scolia proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);

        if (str_starts_with($path, '/v1/scolia/bridge/')) {
            if ($method === 'GET' && $path === '/v1/scolia/bridge/config') return true;
            if ($method === 'POST' && in_array($path, [
                '/v1/scolia/bridge/events',
                '/v1/scolia/bridge/drain',
                '/v1/scolia/bridge/heartbeat',
                '/v1/scolia/bridge/commands/poll',
            ], true)) return true;
            if ($method === 'GET' && preg_match('#^/v1/scolia/bridge/commands/\d+$#', $path) === 1) return true;
            if ($method === 'POST' && preg_match('#^/v1/scolia/bridge/commands/\d+/result$#', $path) === 1) return true;
            return false;
        }

        if ($method === 'GET' && preg_match('#^/v1/kiosks/[^/]+/scolia(?:/status)?$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/kiosks/[^/]+/scolia/(fallback|resume|reset-phase|delete-throw|correct-throw)$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/kiosks/[^/]+/scolia/test-lease/(acquire|heartbeat|release)$#', $path) === 1) return true;

        return false;
    }
}
