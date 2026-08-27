<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\PlayerPortalRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class PlayerPortalApplication
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
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $portal = new PlayerPortalRepository($database);
            $users = new UserAccountRepository($database);
            $response = $this->dispatch($request, $path, $portal, $users);
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
        return ($method === 'GET' && preg_match('#^v1/clubs/\d+/(?:player-directory|elo|summaries)$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/players/\d+/(?:profile|matches)$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/matches/\d+/detail$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/tournaments/\d+/(?:tables|results|summary|summary/admin)$#', $path) === 1)
            || (in_array($method, ['PUT', 'PATCH'], true) && preg_match('#^v1/tournaments/\d+/summary/admin$#', $path) === 1);
    }

    private function dispatch(
        Request $request,
        string $path,
        PlayerPortalRepository $portal,
        UserAccountRepository $users
    ): JsonResponse {
        $method = $request->method();

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/player-directory$#', $path, $m) === 1) {
            return JsonResponse::ok(['club_id' => (int) $m[1], 'items' => $portal->listPlayerDirectory((int) $m[1])]);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/elo$#', $path, $m) === 1) {
            return JsonResponse::ok(['club_id' => (int) $m[1], 'items' => $portal->listEloTable((int) $m[1])]);
        }

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/summaries$#', $path, $m) === 1) {
            return JsonResponse::ok(['club_id' => (int) $m[1], 'items' => $portal->listPublishedSummaries((int) $m[1])]);
        }

        if ($method === 'GET' && preg_match('#^v1/players/(\d+)/profile$#', $path, $m) === 1) {
            $profile = $portal->getPlayerProfile((int) $m[1]);
            if ($profile === null) {
                return JsonResponse::error(404, 'player_not_found', 'Player was not found.');
            }
            return JsonResponse::ok($profile);
        }

        if ($method === 'GET' && preg_match('#^v1/players/(\d+)/matches$#', $path, $m) === 1) {
            return JsonResponse::ok([
                'player_id' => (int) $m[1],
                'items' => $portal->listPlayerMatches((int) $m[1], 200),
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/matches/(\d+)/detail$#', $path, $m) === 1) {
            $detail = $portal->getMatchDetail((int) $m[1]);
            if ($detail === null) {
                return JsonResponse::error(404, 'match_not_found', 'Match was not found.');
            }
            return JsonResponse::ok($detail);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/tables$#', $path, $m) === 1) {
            return JsonResponse::ok($portal->getTournamentTables((int) $m[1]));
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/results$#', $path, $m) === 1) {
            $tables = $portal->getTournamentTables((int) $m[1]);
            return JsonResponse::ok([
                'tournament' => $tables['tournament'],
                'items' => $portal->listTournamentMatches((int) $m[1]),
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/summary$#', $path, $m) === 1) {
            $summary = $portal->getTournamentSummary((int) $m[1]);
            if ($summary === null) {
                return JsonResponse::error(404, 'summary_not_found', 'Published tournament summary was not found.');
            }
            return JsonResponse::ok(['summary' => $summary]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/summary/admin$#', $path, $m) === 1) {
            $tables = $portal->getTournamentTables((int) $m[1]);
            $admin = $this->requireAdmin($request, $users, (int) $tables['tournament']['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            return JsonResponse::ok(['summary' => $portal->getTournamentSummary((int) $m[1], true)]);
        }

        if (in_array($method, ['PUT', 'PATCH'], true)
            && preg_match('#^v1/tournaments/(\d+)/summary/admin$#', $path, $m) === 1) {
            $tables = $portal->getTournamentTables((int) $m[1]);
            $admin = $this->requireAdmin($request, $users, (int) $tables['tournament']['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            $summary = $portal->saveTournamentSummary((int) $m[1], $request->jsonBody(), (int) $admin['id']);
            return JsonResponse::ok(['summary' => $summary]);
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Method is not supported for this player portal route.');
    }

    /** @return array<string, mixed>|JsonResponse */
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

    /** @return array<string, mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $user = $this->requireUser($request, $users);
        if ($user instanceof JsonResponse) {
            return $user;
        }
        if ((string) ($user['role'] ?? '') === 'super_admin') {
            return $user;
        }
        if ((string) ($user['role'] ?? '') !== 'club_admin') {
            return JsonResponse::error(403, 'admin_required', 'Club administrator access is required.');
        }
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $clubIds, true)) {
            return JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
        }
        return $user;
    }
}
