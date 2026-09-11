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
 * Same-origin front door for the read-only player/public/live migration.
 *
 * These routes are deliberately GET-only. Routing is selected before dispatch;
 * when Node is selected, a remote attempt never falls through to legacy PHP.
 */
final class BackendV2PlayerLiveProxyApplication
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
        if ($config->backendV2PlayerLiveRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;

            $result = $client->request('GET', $path, null, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: player-live');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_player_live_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the player/live request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: player-live');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 player/live request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: player-live');
            JsonResponse::error(503, 'backend_v2_player_live_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: player-live');
            JsonResponse::error(500, 'backend_v2_player_live_proxy_failed', 'Player/live proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        if (strtoupper($method) !== 'GET') return false;
        if ($path === '/v1/me/dashboard') return true;
        if (preg_match('#^/v1/players/\d+/profile$#', $path) === 1) return true;
        if (preg_match('#^/v1/players/\d+/elo-tournaments$#', $path) === 1) return true;
        if (preg_match('#^/v1/tournaments/\d+/live-highlights$#', $path) === 1) return true;
        if (preg_match('#^/v1/clubs/\d+/seasons$#', $path) === 1) return true;
        if (preg_match('#^/v1/seasons/\d+$#', $path) === 1) return true;
        if (preg_match('#^/v1/seasons/\d+/standings$#', $path) === 1) return true;
        return false;
    }
}
