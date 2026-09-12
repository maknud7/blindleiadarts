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
 * Same-origin front door for the tournament runtime already implemented in
 * backend-v2. Routing is selected before mutation. Once Node has been attempted
 * the request fails closed and never falls through to a legacy PHP writer.
 */
final class BackendV2TournamentProxyApplication
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
        if ($config->backendV2TournamentRoutingMode() !== 'node') return false;

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

            $result = $client->request($method, $path, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: tournament');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_tournament_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the tournament request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: tournament');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 tournament request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: tournament');
            JsonResponse::error(503, 'backend_v2_tournament_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: tournament');
            JsonResponse::error(500, 'backend_v2_tournament_proxy_failed', 'Tournament proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);

        if ($method === 'GET' && preg_match('#^/v1/clubs/\d+/registration-tournaments$#', $path) === 1) return true;
        if ($method === 'GET' && preg_match('#^/v1/tournaments/\d+/groups$#', $path) === 1) return true;
        if (in_array($method, ['PUT', 'PATCH'], true) && preg_match('#^/v1/tournaments/\d+/registration-settings$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/groups/(?:draw|round-robin)$#', $path) === 1) return true;
        if (in_array($method, ['POST', 'DELETE'], true) && preg_match('#^/v1/tournaments/\d+/register$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/registrations$#', $path) === 1) return true;
        if ($method === 'DELETE' && preg_match('#^/v1/tournaments/\d+/registrations/\d+$#', $path) === 1) return true;

        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/(?:check-in|finish-checkin|start)$#', $path) === 1) return true;

        if ($method === 'GET' && preg_match('#^/v1/tournaments/\d+/operations$#', $path) === 1) return true;
        if (in_array($method, ['PUT', 'PATCH'], true) && preg_match('#^/v1/tournaments/\d+/operations/settings$#', $path) === 1) return true;
        if (in_array($method, ['GET', 'PUT', 'PATCH'], true) && preg_match('#^/v1/tournaments/\d+/operations/boards$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/operations/reconcile$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/operations/matches/\d+/move$#', $path) === 1) return true;

        if ($method === 'GET' && preg_match('#^/v1/tournaments/\d+/playoffs$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^/v1/tournaments/\d+/playoffs/(?:generate|reconcile)$#', $path) === 1) return true;

        return false;
    }
}
