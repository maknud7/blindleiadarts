<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\EloReadRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class EloApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!$this->handles($request->method(), $path)) {
            return false;
        }

        try {
            $database = new Database(Config::load($this->rootPath));
            $response = $this->dispatch(
                $request,
                $path,
                new EloReadRepository($database),
                new UserAccountRepository($database)
            );
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
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
        return ($method === 'GET' && preg_match('#^v1/clubs/\d+/elo$#', $path) === 1)
            || (in_array($method, ['GET', 'PUT', 'PATCH'], true)
                && preg_match('#^v1/tournaments/\d+/elo-settings$#', $path) === 1);
    }

    private function dispatch(
        Request $request,
        string $path,
        EloReadRepository $elo,
        UserAccountRepository $users
    ): JsonResponse {
        $method = $request->method();

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/elo$#', $path, $m) === 1) {
            $items = $elo->listClubElo((int) $m[1]);
            foreach ($items as &$item) {
                // Compatibility with the existing player portal renderer.
                $item['matches_played'] = (int) ($item['elo_matches_played'] ?? 0);
                $item['baseline_played'] = (int) ($item['elo_matches_played'] ?? 0);
            }
            unset($item);
            return JsonResponse::ok([
                'club_id' => (int) $m[1],
                'items' => $items,
            ]);
        }

        if (preg_match('#^v1/tournaments/(\d+)/elo-settings$#', $path, $m) !== 1) {
            return JsonResponse::error(404, 'route_not_found', 'ELO route was not found.');
        }
        $tournamentId = (int) $m[1];
        $setting = $elo->getTournamentEloSetting($tournamentId);
        if ($setting === null) {
            return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
        }

        if ($method === 'GET') {
            return JsonResponse::ok(['tournament' => $setting]);
        }

        $user = $this->requireUser($request, $users);
        if ($user instanceof JsonResponse) {
            return $user;
        }
        $access = $this->requireClubAdmin($user, (int) $setting['club_id']);
        if ($access instanceof JsonResponse) {
            return $access;
        }
        $payload = $request->jsonBody();
        if (!array_key_exists('elo_enabled', $payload)) {
            return JsonResponse::error(422, 'elo_enabled_required', 'elo_enabled is required.');
        }

        return JsonResponse::ok([
            'tournament' => $elo->updateTournamentEloSetting($tournamentId, (bool) $payload['elo_enabled']),
        ]);
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        }
        return $user;
    }

    /** @param array<string,mixed> $user */
    private function requireClubAdmin(array $user, int $clubId): true|JsonResponse
    {
        if ((string) ($user['role'] ?? '') === 'super_admin') {
            return true;
        }
        if ((string) ($user['role'] ?? '') !== 'club_admin') {
            return JsonResponse::error(403, 'admin_required', 'Club administrator access is required.');
        }
        $clubIds = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($user['admin_club_ids'] ?? ''))
        )));
        return in_array($clubId, $clubIds, true)
            ? true
            : JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
    }
}
