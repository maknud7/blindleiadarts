<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentGroupRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli_sql_exception;
use Throwable;

final class TournamentFeatureApplication
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

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $groups = new TournamentGroupRepository($database);
            $users = new UserAccountRepository($database);
            $response = $this->dispatch($request, $path, $groups, $users);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (InvalidArgumentException $error) {
            $response = JsonResponse::error(422, 'invalid_tournament_setup', $error->getMessage());
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(
                500,
                'database_error',
                'Database query failed.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        } catch (Throwable $error) {
            $response = JsonResponse::error(
                500,
                'internal_server_error',
                'Unexpected server error.',
                ['details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null]
            );
        }

        $response->send();
        return true;
    }

    private function handles(string $method, string $path): bool
    {
        return preg_match('#^v1/clubs/\d+/registration-tournaments$#', $path) === 1
            || preg_match('#^v1/tournaments/\d+/registration-settings$#', $path) === 1
            || preg_match('#^v1/tournaments/\d+/groups(?:/draw|/round-robin)?$#', $path) === 1
            || ($method === 'POST' && preg_match('#^v1/tournaments/\d+/register$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/tournaments/\d+/check-in$#', $path) === 1)
            || ($method === 'DELETE' && preg_match('#^v1/tournaments/\d+/register$#', $path) === 1)
            || preg_match('#^v1/tournaments/\d+/registrations(?:/\d+)?$#', $path) === 1;
    }

    private function dispatch(
        Request $request,
        string $path,
        TournamentGroupRepository $groups,
        UserAccountRepository $users
    ): JsonResponse {
        $method = $request->method();

        if ($method === 'GET' && preg_match('#^v1/clubs/(\d+)/registration-tournaments$#', $path, $m) === 1) {
            return JsonResponse::ok([
                'club_id' => (int) $m[1],
                'items' => $groups->listRegistrationTournamentsByClubId((int) $m[1]),
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/groups$#', $path, $m) === 1) {
            return JsonResponse::ok($groups->getGroups((int) $m[1]));
        }

        if (in_array($method, ['PUT', 'PATCH'], true)
            && preg_match('#^v1/tournaments/(\d+)/registration-settings$#', $path, $m) === 1) {
            $tournament = $groups->findTournament((int) $m[1]);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            return JsonResponse::ok([
                'tournament' => $groups->updateRegistrationSettings((int) $m[1], $request->jsonBody()),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/groups/draw$#', $path, $m) === 1) {
            $tournament = $groups->findTournament((int) $m[1]);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            $payload = $request->jsonBody();
            $groupCount = (int) ($payload['group_count'] ?? 0);
            $mode = (string) ($payload['mode'] ?? 'elo_snake');
            $drawSeed = isset($payload['draw_seed']) ? (int) $payload['draw_seed'] : null;
            return JsonResponse::ok($groups->drawGroups((int) $m[1], $groupCount, $mode, $drawSeed));
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/groups/round-robin$#', $path, $m) === 1) {
            $tournament = $groups->findTournament((int) $m[1]);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            $bestOfLegs = (int) ($request->jsonBody()['best_of_legs'] ?? 0);
            return JsonResponse::ok($groups->generateRoundRobin((int) $m[1], $bestOfLegs), 201);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/register$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                return $user;
            }
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'This account is not linked to a player profile.');
            }
            return JsonResponse::ok([
                'registration' => $groups->registerPlayer((int) $m[1], $playerId, 'player'),
            ], 201);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/check-in$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                return $user;
            }
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'This account is not linked to a player profile.');
            }
            return JsonResponse::ok([
                'registration' => $groups->checkInPlayer((int) $m[1], $playerId),
            ]);
        }

        if ($method === 'DELETE' && preg_match('#^v1/tournaments/(\d+)/register$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                return $user;
            }
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'This account is not linked to a player profile.');
            }
            return JsonResponse::ok([
                'registration' => $groups->withdrawPlayer((int) $m[1], $playerId),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/registrations$#', $path, $m) === 1) {
            $tournament = $groups->findTournament((int) $m[1]);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            $playerId = (int) ($request->jsonBody()['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_required', 'player_id is required.');
            }
            return JsonResponse::ok([
                'registration' => $groups->registerPlayer((int) $m[1], $playerId, 'admin'),
            ], 201);
        }

        if ($method === 'DELETE' && preg_match('#^v1/tournaments/(\d+)/registrations/(\d+)$#', $path, $m) === 1) {
            $tournament = $groups->findTournament((int) $m[1]);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            return JsonResponse::ok([
                'registration' => $groups->withdrawPlayer((int) $m[1], (int) $m[2]),
            ]);
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Method is not supported for this tournament feature route.');
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
        $clubIds = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($user['admin_club_ids'] ?? ''))
        )));
        if (!in_array($clubId, $clubIds, true)) {
            return JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
        }
        return $user;
    }
}
