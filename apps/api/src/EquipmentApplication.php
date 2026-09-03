<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\EquipmentRepository;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

/**
 * Equipment routes are handled before the general Application router so physical
 * board master data can use the shared PROD hardware namespace while the rest of
 * TEST remains isolated.
 */
final class EquipmentApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        $method = $request->method();

        if (!$this->handles($method, $path)) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $users = new UserAccountRepository($database);
            $repo = new EquipmentRepository($database);
            $kiosks = new KioskRepository($database);

            if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/kiosks$#', $path, $matches) === 1) {
                $clubId = (int) $matches[1];
                $response = JsonResponse::ok([
                    'club_id' => $clubId,
                    'items' => $repo->listBoards($clubId),
                ] + $repo->scope());
            } elseif ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/kiosks$#', $path, $matches) === 1) {
                $clubId = (int) $matches[1];
                $admin = $this->requireAdmin($request, $users, $clubId);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $response = JsonResponse::ok([
                        'kiosk' => $repo->createBoard($clubId, $request->jsonBody()),
                    ] + $repo->scope(), 201);
                }
            } elseif ($method === 'PATCH' && preg_match('#^v1/clubs/(\d+)/kiosks/(\d+)$#', $path, $matches) === 1) {
                $clubId = (int) $matches[1];
                $admin = $this->requireAdmin($request, $users, $clubId);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $board = $repo->updateBoard($clubId, (int) $matches[2], $request->jsonBody());
                    $response = $board !== null
                        ? JsonResponse::ok(['kiosk' => $board] + $repo->scope())
                        : JsonResponse::error(404, 'kiosk_not_found', 'Skiva ble ikke funnet i valgt klubb.');
                }
            } elseif ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/kiosks/(\d+)/reset-pairing$#', $path, $matches) === 1) {
                $clubId = (int) $matches[1];
                $admin = $this->requireAdmin($request, $users, $clubId);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $board = $repo->resetPairing($clubId, (int) $matches[2]);
                    $response = $board !== null
                        ? JsonResponse::ok(['kiosk' => $board] + $repo->scope())
                        : JsonResponse::error(404, 'kiosk_not_found', 'Skiva ble ikke funnet i valgt klubb.');
                }
            } elseif ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/kiosk-pairing-requests/([^/]+)/approve$#', $path, $matches) === 1) {
                $clubId = (int) $matches[1];
                $admin = $this->requireAdmin($request, $users, $clubId);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $payload = $request->jsonBody();
                    $physicalId = (int) ($payload['kiosk_id'] ?? 0);
                    if ($physicalId <= 0) {
                        $response = JsonResponse::error(422, 'kiosk_required', 'kiosk_id er påkrevd for å godkjenne pairing.');
                    } else {
                        $runtimeId = $repo->ensureRuntimeAlias($clubId, $physicalId);
                        $approval = $kiosks->approvePairingRequest($clubId, (string) $matches[2], $runtimeId, (int) $admin['id']);
                        $response = $approval !== null
                            ? JsonResponse::ok($approval + [
                                'physical_kiosk_id' => $physicalId,
                                'runtime_kiosk_id' => $runtimeId,
                            ] + $repo->scope())
                            : JsonResponse::error(404, 'pairing_request_not_found', 'Pairingforespørselen ble ikke funnet.');
                    }
                }
            } elseif ($method === 'DELETE' && preg_match('#^v1/clubs/(\d+)/kiosks/(\d+)$#', $path, $matches) === 1) {
                $admin = $this->requireSuperAdmin($request, $users);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $deleted = $repo->deleteBoard((int) $matches[1], (int) $matches[2]);
                    $response = $deleted
                        ? JsonResponse::ok(['deleted' => true, 'kind' => 'board', 'id' => (int) $matches[2]] + $repo->scope())
                        : JsonResponse::error(404, 'board_not_found', 'Skiva ble ikke funnet i valgt klubb.');
                }
            } elseif ($method === 'DELETE' && preg_match('#^v1/clubs/(\d+)/screen-devices/(\d+)$#', $path, $matches) === 1) {
                $admin = $this->requireSuperAdmin($request, $users);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } else {
                    $deleted = $repo->deleteScreen((int) $matches[1], (int) $matches[2]);
                    $response = $deleted
                        ? JsonResponse::ok(['deleted' => true, 'kind' => 'screen', 'id' => (int) $matches[2]])
                        : JsonResponse::error(404, 'screen_not_found', 'Venue-skjermen ble ikke funnet i valgt klubb.');
                }
            } else {
                return false;
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

    private function handles(string $method, string $path): bool
    {
        if ($method === 'GET' && preg_match('#^v1/clubs/\d+/kiosks$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^v1/clubs/\d+/kiosks$#', $path) === 1) return true;
        if ($method === 'PATCH' && preg_match('#^v1/clubs/\d+/kiosks/\d+$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^v1/clubs/\d+/kiosks/\d+/reset-pairing$#', $path) === 1) return true;
        if ($method === 'POST' && preg_match('#^v1/clubs/\d+/kiosk-pairing-requests/[^/]+/approve$#', $path) === 1) return true;
        return $method === 'DELETE' && preg_match('#^v1/clubs/\d+/(?:kiosks|screen-devices)/\d+$#', $path) === 1;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return JsonResponse::error(403, 'admin_required', 'Club administrator access is required.');
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $clubIds, true)) return JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
        return $user;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireSuperAdmin(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        if ((string) ($user['role'] ?? '') !== 'super_admin') return JsonResponse::error(403, 'super_admin_required', 'Bare superadmin kan slette klubbutstyr.');
        return $user;
    }
}
