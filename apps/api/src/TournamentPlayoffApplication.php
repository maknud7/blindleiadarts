<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentGroupRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentPlayoffRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli_sql_exception;
use Throwable;

final class TournamentPlayoffApplication
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
            $playoffs = new TournamentPlayoffRepository($database);
            $groups = new TournamentGroupRepository($database);
            $users = new UserAccountRepository($database);
            $response = $this->dispatch($request, $path, $playoffs, $groups, $users);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (InvalidArgumentException $error) {
            $response = JsonResponse::error(422, 'invalid_playoff_setup', $error->getMessage());
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
        if ($method === 'GET' && preg_match('#^v1/tournaments/\d+/playoffs$#', $path) === 1) {
            return true;
        }
        if ($method !== 'POST') {
            return false;
        }
        return preg_match('#^v1/tournaments/\d+/playoffs/(generate|reconcile)$#', $path) === 1;
    }

    private function dispatch(
        Request $request,
        string $path,
        TournamentPlayoffRepository $playoffs,
        TournamentGroupRepository $groups,
        UserAccountRepository $users
    ): JsonResponse {
        if (preg_match('#^v1/tournaments/(\d+)/playoffs(?:/(generate|reconcile))?$#', $path, $matches) !== 1) {
            return JsonResponse::error(404, 'route_not_found', 'Playoff route was not found.');
        }
        $tournamentId = (int) $matches[1];
        $action = (string) ($matches[2] ?? '');
        $tournament = $groups->findTournament($tournamentId);
        if ($tournament === null) {
            return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
        }

        if ($request->method() === 'GET') {
            return JsonResponse::ok([
                'bracket' => $playoffs->getBracket($tournamentId),
            ]);
        }

        $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
        if ($admin instanceof JsonResponse) {
            return $admin;
        }

        if ($action === 'generate') {
            $payload = $request->jsonBody();
            $qualifiersPerGroup = (int) ($payload['qualifiers_per_group'] ?? 0);
            $bestOfLegs = (int) ($payload['best_of_legs'] ?? 0);
            return JsonResponse::ok([
                'bracket' => $playoffs->generateFromGroups($tournamentId, $qualifiersPerGroup, $bestOfLegs),
            ], 201);
        }
        if ($action === 'reconcile') {
            return JsonResponse::ok([
                'bracket' => $playoffs->reconcileTournament($tournamentId),
            ]);
        }
        return JsonResponse::error(405, 'method_not_allowed', 'Unsupported playoff action.');
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

    /** @return array<string,mixed>|JsonResponse */
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
