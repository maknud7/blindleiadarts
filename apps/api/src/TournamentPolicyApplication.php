<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentCheckinRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentPolicyRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class TournamentPolicyApplication
{
    public function __construct(private readonly string $rootPath) {}

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!$this->handles($request->method(), $path)) return false;

        try {
            $database = new Database(Config::load($this->rootPath));
            $response = $this->dispatch(
                $request,
                $path,
                new TournamentPolicyRepository($database),
                new TournamentCheckinRepository($database),
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
        return ($method === 'POST' && preg_match('#^v1/clubs/\d+/tournaments$#', $path) === 1)
            || (in_array($method, ['PUT','PATCH'], true) && preg_match('#^v1/tournaments/\d+/registration-settings$#', $path) === 1)
            || (in_array($method, ['PUT','PATCH'], true) && preg_match('#^v1/tournaments/\d+/checkin-settings$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/tournaments/\d+/policy$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/tournaments/\d+/start$#', $path) === 1)
            || ($method === 'GET' && $path === 'v1/superadmin/clubs')
            || (in_array($method, ['PUT','PATCH'], true) && preg_match('#^v1/superadmin/clubs/\d+$#', $path) === 1);
    }

    private function dispatch(
        Request $request,
        string $path,
        TournamentPolicyRepository $policy,
        TournamentCheckinRepository $checkin,
        UserAccountRepository $users
    ): JsonResponse {
        $method = $request->method();

        if ($method === 'POST' && preg_match('#^v1/clubs/(\d+)/tournaments$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            $admin = $this->requireClubAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) return $admin;
            return JsonResponse::ok(['tournament' => $policy->createTournament($clubId, $request->jsonBody())], 201);
        }

        if (preg_match('#^v1/tournaments/(\d+)/(registration-settings|checkin-settings|policy|start)$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $current = $policy->policy($tournamentId);
            if ($current === null) return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            $admin = $this->requireClubAdmin($request, $users, (int) $current['club_id']);
            if ($admin instanceof JsonResponse) return $admin;
            $action = (string) $m[2];

            if ($method === 'GET' && $action === 'policy') {
                return JsonResponse::ok(['tournament' => $current]);
            }
            if (in_array($method, ['PUT','PATCH'], true) && $action === 'registration-settings') {
                return JsonResponse::ok(['tournament' => $policy->updateRegistrationSettings($tournamentId, $request->jsonBody())]);
            }
            if (in_array($method, ['PUT','PATCH'], true) && $action === 'checkin-settings') {
                $policy->enforceFixedWindows($tournamentId);
                $body = $request->jsonBody();
                $clean = [];
                foreach (['checkin_method','checkin_code','rotate_checkin_code'] as $key) {
                    if (array_key_exists($key, $body)) $clean[$key] = $body[$key];
                }
                $settings = $checkin->updateTournamentSettings($tournamentId, $clean);
                $policy->enforceFixedWindows($tournamentId);
                if (is_array($settings)) {
                    $settings['effective_checkin_opens_at'] = $current['checkin_opens_at'];
                    $settings['effective_checkin_closes_at'] = null;
                    $settings['closes_on_start'] = true;
                }
                return JsonResponse::ok(['settings' => $settings]);
            }
            if ($method === 'POST' && $action === 'start') {
                return JsonResponse::ok(['tournament' => $policy->startTournament($tournamentId)]);
            }
            return JsonResponse::error(405, 'method_not_allowed', 'Metoden støttes ikke.');
        }

        if ($method === 'GET' && $path === 'v1/superadmin/clubs') {
            $admin = $this->requireSuperAdmin($request, $users);
            if ($admin instanceof JsonResponse) return $admin;
            return JsonResponse::ok(['items' => $policy->listClubsForSuperadmin()]);
        }

        if (in_array($method, ['PUT','PATCH'], true) && preg_match('#^v1/superadmin/clubs/(\d+)$#', $path, $m) === 1) {
            $admin = $this->requireSuperAdmin($request, $users);
            if ($admin instanceof JsonResponse) return $admin;
            return JsonResponse::ok(['club' => $policy->updateClubBilling((int) $m[1], $request->jsonBody())]);
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Metoden støttes ikke.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        $user = $users->findBySessionToken($token);
        return $user ?? JsonResponse::error(401, 'invalid_session', 'Sesjonen er ugyldig eller utløpt.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireClubAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $user = $this->requireUser($request, $users);
        if ($user instanceof JsonResponse) return $user;
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return JsonResponse::error(403, 'admin_required', 'Klubbadministrator kreves.');
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        return in_array($clubId, $clubIds, true)
            ? $user
            : JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til denne klubben.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireSuperAdmin(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $user = $this->requireUser($request, $users);
        if ($user instanceof JsonResponse) return $user;
        return (string) ($user['role'] ?? '') === 'super_admin'
            ? $user
            : JsonResponse::error(403, 'superadmin_required', 'Superadmin-tilgang kreves.');
    }
}
