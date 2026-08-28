<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\PaymentSettingsRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class PaymentSettingsApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        $method = $request->method();
        if (!in_array($method, ['GET', 'PUT', 'PATCH'], true)
            || preg_match('#^v1/clubs/(\d+)/payment-settings$#', $path, $matches) !== 1) {
            return false;
        }

        $config = null;
        try {
            $clubId = (int) $matches[1];
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $admin = $this->requireAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) {
                $admin->send();
                return true;
            }

            $settings = new PaymentSettingsRepository($database);
            if ($method === 'GET') {
                $response = JsonResponse::ok(['settings' => $settings->adminSettings($clubId)]);
            } else {
                $saved = $settings->saveAdminSettings($clubId, $request->jsonBody());
                $response = JsonResponse::ok([
                    'settings' => $saved,
                    'message' => 'Betalingsinnstillingene er lagret.',
                ]);
            }
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'payment_settings_database_error',
                'Betalingsinnstillingene er midlertidig utilgjengelige.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'payment_settings_internal_error',
                'Betalingsinnstillingene er midlertidig utilgjengelige.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null || trim($token) === '') {
            return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        if ((string) ($user['role'] ?? '') === 'super_admin') {
            return $user;
        }
        if ((string) ($user['role'] ?? '') !== 'club_admin') {
            return JsonResponse::error(403, 'admin_required', 'Administratortilgang kreves.');
        }
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $clubIds, true)) {
            return JsonResponse::error(403, 'club_access_denied', 'Du kan ikke administrere denne klubben.');
        }
        return $user;
    }
}
