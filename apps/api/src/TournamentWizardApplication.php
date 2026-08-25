<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentWizardRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class TournamentWizardApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (preg_match('#^v1/tournaments/(\d+)/wizard-plan$#', $path) !== 1) return false;

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $repo = new TournamentWizardRepository($database);
            $users = new UserAccountRepository($database);
            $response = $this->dispatch($request, $path, $repo, $users);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.');
        } catch (Throwable) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.');
        }
        $response->send();
        return true;
    }

    private function dispatch(Request $request, string $path, TournamentWizardRepository $repo, UserAccountRepository $users): JsonResponse
    {
        preg_match('#^v1/tournaments/(\d+)/wizard-plan$#', $path, $m);
        $tournamentId = (int) $m[1];
        $plan = $repo->getPlan($tournamentId);
        if ($plan === null) return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
        $admin = $this->requireAdmin($request, $users, (int) $plan['club_id']);
        if ($admin instanceof JsonResponse) return $admin;

        if ($request->method() === 'GET') return JsonResponse::ok(['plan' => $plan]);
        if (in_array($request->method(), ['PATCH','PUT'], true)) {
            return JsonResponse::ok(['plan' => $repo->updatePlan($tournamentId, $request->jsonBody())]);
        }
        return JsonResponse::error(405, 'method_not_allowed', 'Method not allowed.');
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
}
