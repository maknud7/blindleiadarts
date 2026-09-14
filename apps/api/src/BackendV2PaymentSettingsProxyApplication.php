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
 * Same-origin payment-settings front door. Routing is selected before any
 * legacy database work and a Node attempt never falls through to PHP.
 */
final class BackendV2PaymentSettingsProxyApplication
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
        if ($config->backendV2PaymentSettingsRoutingMode() !== 'node') return false;

        try {
            $client = new BackendV2ApiClient(
                $config->backendV2BaseUrl(),
                $config->backendV2InternalToken()
            );
            $headers = [];
            $authorization = $request->header('authorization');
            if ($authorization !== null) $headers['authorization'] = $authorization;
            $body = in_array($method, ['PUT', 'PATCH'], true) ? $request->jsonBody() : null;
            $result = $client->request($method, $path, $body, $headers);
            $status = $result['status'];
            $payload = $result['payload'];
            header('X-BD-Backend-V2: payment-settings');

            if ($status >= 200 && $status < 300 && ($payload['ok'] ?? null) === true) {
                unset($payload['ok']);
                JsonResponse::ok($payload, $status)->send();
                return true;
            }

            $error = is_array($payload['error'] ?? null) ? $payload['error'] : [];
            $code = trim((string) ($error['code'] ?? '')) ?: 'backend_v2_payment_settings_failed';
            $message = trim((string) ($error['message'] ?? '')) ?: 'Backend-v2 rejected the payment settings request.';
            $meta = is_array($error['meta'] ?? null) ? $error['meta'] : [];
            JsonResponse::error($status > 0 ? $status : 502, $code, $message, $meta)->send();
            return true;
        } catch (BackendV2ApiAttemptException $error) {
            header('X-BD-Backend-V2: payment-settings');
            JsonResponse::error(
                502,
                $error->errorCode,
                'Backend-v2 payment settings request failed after dispatch; PHP fallback is disabled.'
            )->send();
            return true;
        } catch (InvalidArgumentException $error) {
            header('X-BD-Backend-V2: payment-settings');
            JsonResponse::error(503, 'backend_v2_payment_settings_unconfigured', $error->getMessage())->send();
            return true;
        } catch (Throwable) {
            header('X-BD-Backend-V2: payment-settings');
            JsonResponse::error(
                500,
                'backend_v2_payment_settings_proxy_failed',
                'Payment settings proxy failed before a safe response was produced.'
            )->send();
            return true;
        }
    }

    public function handles(string $method, string $path): bool
    {
        return in_array(strtoupper($method), ['GET', 'PUT', 'PATCH'], true)
            && preg_match('#^/v1/clubs/\d+/payment-settings$#', $path) === 1;
    }
}
