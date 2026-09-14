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
 * Same-origin front door for read-only authenticated account surfaces already
 * implemented in backend-v2.
 *
 * TEST shares canonical PROD identity tables. These routes are therefore kept
 * strictly GET-only: backend-v2 resolves the bearer session without touching it
 * when identity_prefix differs from the TEST runtime prefix. Identity mutations
 * remain on PHP until the identity cutover has its own safe write boundary.
 */
final class BackendV2AccountReadProxyApplication
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
        // Reuse the read-only player/live cutover switch. It is already TEST=node
        // and PROD=php, which is the exact safety boundary these account reads need.
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
            header('X-BD-Backend-V2: account-read');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_account_read_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the account read.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: account-read');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 account read failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: account-read');
            JsonResponse::error(503, 'backend_v2_account_read_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: account-read');
            JsonResponse::error(500, 'backend_v2_account_read_proxy_failed', 'Account read proxy failed before a safe response was produced.')->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        if (strtoupper($method) !== 'GET') return false;

        return in_array($path, [
            '/v1/auth/me',
            '/v1/me/profile',
            '/v1/me/payments',
            '/v1/me/eligibility',
        ], true);
    }
}
