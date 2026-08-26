<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\EquipmentRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class EquipmentApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');

        if ($request->method() !== 'DELETE' || preg_match('#^v1/clubs/\d+/(?:kiosks|screen-devices)/\d+$#', $path) !== 1) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $admin = $this->requireSuperAdmin($request, $users);
            if ($admin instanceof JsonResponse) {
                $admin->send();
                return true;
            }

            $repo = new EquipmentRepository($database);
            if (preg_match('#^v1/clubs/(\d+)/kiosks/(\d+)$#', $path, $matches) === 1) {
                $deleted = $repo->deleteBoard((int) $matches[1], (int) $matches[2]);
                $response = $deleted
                    ? JsonResponse::ok(['deleted' => true, 'kind' => 'board', 'id' => (int) $matches[2]])
                    : JsonResponse::error(404, 'board_not_found', 'Skiva ble ikke funnet i valgt klubb.');
            } elseif (preg_match('#^v1/clubs/(\d+)/screen-devices/(\d+)$#', $path, $matches) === 1) {
                $deleted = $repo->deleteScreen((int) $matches[1], (int) $matches[2]);
                $response = $deleted
                    ? JsonResponse::ok(['deleted' => true, 'kind' => 'screen', 'id' => (int) $matches[2]])
                    : JsonResponse::error(404, 'screen_not_found', 'Venue-skjermen ble ikke funnet i valgt klubb.');
            } else {
                $response = JsonResponse::error(404, 'equipment_route_not_found', 'Ukjent utstyrsrute.');
            }
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.', ['details' => $error->getMessage()]);
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.', ['details' => $error->getMessage()]);
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireSuperAdmin(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        }
        if ((string) ($user['role'] ?? '') !== 'super_admin') {
            return JsonResponse::error(403, 'super_admin_required', 'Bare superadmin kan slette klubbutstyr.');
        }
        return $user;
    }
}
