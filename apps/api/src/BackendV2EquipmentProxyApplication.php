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
 * Same-origin PHP front door for the equipment backend-v2 cutover.
 *
 * Routing is decided before the request is dispatched. Once Node has been
 * attempted, this application always returns the Node result (or a fail-closed
 * transport error) and never invokes the legacy PHP writer.
 */
final class BackendV2EquipmentProxyApplication
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
        if ($config->backendV2EquipmentRoutingMode() !== 'node') return false;

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

            $result = $client->request($method, $path, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: equipment');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_equipment_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the equipment request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            // Never fall through to PHP after a remote attempt: outcome may be unknown.
            header('X-BD-Backend-V2: equipment');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 equipment request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            // Routing was explicitly set to Node, so invalid/missing config must fail
            // closed rather than silently re-enable the legacy writer.
            header('X-BD-Backend-V2: equipment');
            JsonResponse::error(503, 'backend_v2_equipment_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable $error) {
            header('X-BD-Backend-V2: equipment');
            JsonResponse::error(500, 'backend_v2_equipment_proxy_failed', 'Equipment proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);

        // Physical board deletion remains on PHP until Node has identical match
        // history and reference cleanup protection. Do not add DELETE here yet.
        if (preg_match('#^/v1/clubs/\d+/kiosks/\d+$#', $path) === 1) {
            return in_array($method, ['PUT', 'PATCH'], true);
        }

        if (preg_match('#^/v1/clubs/\d+/kiosks$#', $path) === 1) {
            return in_array($method, ['GET', 'POST'], true);
        }
        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/equipment/boards$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/kiosks/\d+/reset-pairing$#', $path) === 1) return true;
        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/kiosk-pairing-requests$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/kiosk-pairing-requests/[^/]+/approve$#', $path) === 1) return true;
        if ($method === 'POST' && $path === '/v1/kiosk-pairing-requests') return true;
        if ($method === 'GET' && preg_match('#^/v1/kiosk-pairing-requests/[^/]+$#', $path) === 1) return true;

        if (preg_match('#^/v1/clubs/\d+/screen-devices$#', $path) === 1) {
            return in_array($method, ['GET', 'POST'], true);
        }
        if ($method === 'DELETE' && preg_match('#^/v1/clubs/\d+/screen-devices/\d+$#', $path) === 1) return true;

        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/scolia$#', $path) === 1) return true;
        if (preg_match('#^/v1/clubs/\d+/scolia/settings$#', $path) === 1) {
            return in_array($method, ['GET', 'PUT', 'PATCH'], true);
        }
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/scolia/incidents/\d+/resolve$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/scolia/events/\d+/retry$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/scolia/cleanup$#', $path) === 1) return true;

        if (preg_match('#^/v1/clubs/\d+/kiosks/\d+/scolia$#', $path) === 1) {
            return in_array($method, ['GET', 'PUT', 'PATCH'], true);
        }
        if ($method === 'POST' && preg_match('#^/v1/clubs/\d+/kiosks/\d+/scolia/(fallback|resume|reset-phase)$#', $path) === 1) return true;

        return false;
    }
}
