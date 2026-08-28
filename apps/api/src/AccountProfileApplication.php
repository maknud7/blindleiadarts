<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\AccountProfileRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class AccountProfileApplication
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

        $isProfileRead = $method === 'GET' && $path === 'v1/me/profile';
        $isPaymentsRead = $method === 'GET' && $path === 'v1/me/payments';
        $isProfileUpdate = in_array($method, ['PUT', 'PATCH'], true) && $path === 'v1/me/profile';
        $isPasswordUpdate = $method === 'POST' && $path === 'v1/me/password';
        if (!$isProfileRead && !$isPaymentsRead && !$isProfileUpdate && !$isPasswordUpdate) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                $user->send();
                return true;
            }

            $profiles = new AccountProfileRepository($database);
            if ($isProfileRead) {
                $response = JsonResponse::ok(['profile' => $profiles->profileForUser($user)]);
            } elseif ($isPaymentsRead) {
                $response = JsonResponse::ok($profiles->membershipAndPayments($user));
            } elseif ($isProfileUpdate) {
                $payload = $request->jsonBody();
                $profile = $profiles->updateProfile(
                    $user,
                    trim((string) ($payload['display_name'] ?? '')),
                    array_key_exists('nickname', $payload) ? (string) $payload['nickname'] : null
                );
                $response = JsonResponse::ok([
                    'profile' => $profile,
                    'message' => 'Profilen er oppdatert.',
                ]);
            } else {
                $payload = $request->jsonBody();
                $profiles->changePassword(
                    $user,
                    (string) ($payload['current_password'] ?? ''),
                    (string) ($payload['new_password'] ?? '')
                );
                $response = JsonResponse::ok([
                    'message' => 'Passordet er endret. Andre innlogginger er logget ut.',
                ]);
            }
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'profile_database_error',
                'Profilen er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'profile_internal_error',
                'Profilen er midlertidig utilgjengelig.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null || trim($token) === '') {
            return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        return $user;
    }
}
