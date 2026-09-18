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
 * Same-origin front door for authenticated account mutations that are safe in
 * TEST with split runtime/identity prefixes.
 *
 * TEST login reads canonical PROD credentials, creates only bd_test_ sessions
 * and writes auth audit events to bd_test_. Profile updates mutate the TEST
 * player actor only. Password change/reset is routed to Node in TEST solely so
 * the backend can fail closed with the canonical PROD-identity-only error.
 */
final class BackendV2AccountMutationProxyApplication
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
        if ($config->backendV2AccountMutationRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;
            $body = $request->jsonBody();

            $result = $client->request($method, $path, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: account-mutation');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_account_mutation_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the account request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: account-mutation');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 account mutation failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: account-mutation');
            JsonResponse::error(503, 'backend_v2_account_mutation_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: account-mutation');
            JsonResponse::error(
                500,
                'backend_v2_account_mutation_proxy_failed',
                'Account mutation proxy failed before a safe response was produced.'
            )->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        $method = strtoupper($method);
        if ($method === 'POST' && $path === '/v1/auth/login') return true;
        if (in_array($method, ['PUT', 'PATCH'], true) && $path === '/v1/me/profile') return true;
        if ($method === 'POST' && $path === '/v1/me/password') return true;
        if ($method === 'POST' && in_array($path, [
            '/v1/auth/password-reset/request',
            '/v1/auth/password-reset/confirm',
        ], true)) return true;
        return false;
    }
}
