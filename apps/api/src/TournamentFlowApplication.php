<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentFlowRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class TournamentFlowApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if ($request->method() !== 'POST' || preg_match('#^v1/tournaments/(\d+)/start$#', $path) !== 1) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $repo = new TournamentFlowRepository($database);
            $users = new UserAccountRepository($database);
            preg_match('#^v1/tournaments/(\d+)/start$#', $path, $matches);
            $tournamentId = (int) $matches[1];
            $tournament = $repo->findTournament($tournamentId);
            if ($tournament === null) {
                $response = JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            } else {
                $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
                $response = $admin instanceof JsonResponse
                    ? $admin
                    : JsonResponse::ok(['start' => $repo->startTournament($tournamentId)]);
            }
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

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') {
            return JsonResponse::error(403, 'admin_required', 'Club administrator access is required.');
        }
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        return in_array($clubId, $clubIds, true)
            ? $user
            : JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
    }
}
