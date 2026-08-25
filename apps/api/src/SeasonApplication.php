<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\SeasonRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli_sql_exception;
use Throwable;

final class SeasonApplication
{
    public function __construct(private readonly string $rootPath) {}

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!$this->handles($request->method(), $path)) return false;

        try {
            $db = new Database(Config::load($this->rootPath));
            $response = $this->dispatch($request, $path, new SeasonRepository($db), new UserAccountRepository($db));
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (InvalidArgumentException $error) {
            $response = JsonResponse::error(422, 'season_validation_failed', $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.');
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.');
        }
        $response->send();
        return true;
    }

    private function handles(string $method, string $path): bool
    {
        return preg_match('#^v1/clubs/\d+/seasons$#', $path) === 1
            || preg_match('#^v1/seasons/\d+(?:/(?:standings|activate|complete))?$#', $path) === 1;
    }

    private function dispatch(Request $request, string $path, SeasonRepository $seasons, UserAccountRepository $users): JsonResponse
    {
        $method = $request->method();
        if (preg_match('#^v1/clubs/(\d+)/seasons$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            if ($method === 'GET') return JsonResponse::ok(['club_id' => $clubId, 'items' => $seasons->listByClub($clubId)]);
            if ($method !== 'POST') return JsonResponse::error(405, 'method_not_allowed', 'Metoden støttes ikke.');
            $admin = $this->requireClubAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) return $admin;
            return JsonResponse::ok(['season' => $seasons->create($clubId, $request->jsonBody())], 201);
        }

        if (preg_match('#^v1/seasons/(\d+)(?:/(standings|activate|complete))?$#', $path, $m) !== 1) {
            return JsonResponse::error(404, 'season_route_not_found', 'Sesongruten ble ikke funnet.');
        }
        $seasonId = (int) $m[1];
        $action = (string) ($m[2] ?? '');
        $season = $seasons->find($seasonId);
        if ($season === null) return JsonResponse::error(404, 'season_not_found', 'Sesongen ble ikke funnet.');

        if ($action === 'standings' && $method === 'GET') {
            return JsonResponse::ok(['season' => $season, 'items' => $seasons->standings($seasonId)]);
        }
        if ($action === '' && $method === 'GET') return JsonResponse::ok(['season' => $season]);

        $admin = $this->requireClubAdmin($request, $users, (int) $season['club_id']);
        if ($admin instanceof JsonResponse) return $admin;
        if ($action === '' && in_array($method, ['PATCH','PUT'], true)) {
            return JsonResponse::ok(['season' => $seasons->update($seasonId, $request->jsonBody())]);
        }
        if ($action === 'activate' && $method === 'POST') return JsonResponse::ok(['season' => $seasons->activate($seasonId)]);
        if ($action === 'complete' && $method === 'POST') return JsonResponse::ok(['season' => $seasons->complete($seasonId)]);
        return JsonResponse::error(405, 'method_not_allowed', 'Metoden støttes ikke.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireClubAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Sesjonen er ugyldig eller utløpt.');
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return JsonResponse::error(403, 'admin_required', 'Klubbadministrator kreves.');
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        return in_array($clubId, $clubIds, true) ? $user : JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til denne klubben.');
    }
}