<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\TournamentCheckinRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class TournamentCheckinApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!$this->handles($request->method(), $path)) return false;

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $repo = new TournamentCheckinRepository($database);
            $users = new UserAccountRepository($database);
            $response = $this->dispatch($request, $path, $repo, $users);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
        } catch (mysqli_sql_exception) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.');
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.');
        }
        $response->send();
        return true;
    }

    private function handles(string $method, string $path): bool
    {
        return ($method === 'POST' && preg_match('#^v1/tournaments/\d+/check-in$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/tournaments/\d+/check-in-status$#', $path) === 1)
            || (in_array($method, ['GET','PATCH','PUT'], true) && preg_match('#^v1/clubs/\d+/checkin-settings$#', $path) === 1)
            || (in_array($method, ['GET','PATCH','PUT'], true) && preg_match('#^v1/tournaments/\d+/checkin-settings$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/tournaments/\d+/admin-check-in/\d+$#', $path) === 1);
    }

    private function dispatch(Request $request, string $path, TournamentCheckinRepository $repo, UserAccountRepository $users): JsonResponse
    {
        $method = $request->method();
        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/check-in$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) return $user;
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) return JsonResponse::error(422, 'player_profile_missing', 'Kontoen er ikke koblet til en spillerprofil.');
            $payload = $request->jsonBody();
            $lat = $this->nullableFloat($payload['latitude'] ?? null);
            $lng = $this->nullableFloat($payload['longitude'] ?? null);
            $accuracy = $this->nullableFloat($payload['accuracy_meters'] ?? null);
            return JsonResponse::ok([
                'registration' => $repo->checkInPlayer((int) $m[1], $playerId, $lat, $lng, $accuracy, false),
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/check-in-status$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) return $user;
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) return JsonResponse::error(422, 'player_profile_missing', 'Kontoen er ikke koblet til en spillerprofil.');
            return JsonResponse::ok($repo->statusForPlayer((int) $m[1], $playerId));
        }

        if (preg_match('#^v1/clubs/(\d+)/checkin-settings$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            $admin = $this->requireAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) return $admin;
            if ($method === 'GET') return JsonResponse::ok(['settings' => $repo->getClubSettings($clubId)]);
            return JsonResponse::ok(['settings' => $repo->updateClubSettings($clubId, $request->jsonBody(), (int) $admin['id'])]);
        }

        if (preg_match('#^v1/tournaments/(\d+)/checkin-settings$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            $admin = $this->requireAdmin($request, $users, (int) $settings['club_id']);
            if ($admin instanceof JsonResponse) return $admin;
            if ($method === 'GET') return JsonResponse::ok(['settings' => $settings]);
            return JsonResponse::ok(['settings' => $repo->updateTournamentSettings($tournamentId, $request->jsonBody())]);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/admin-check-in/(\d+)$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $playerId = (int) $m[2];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            $admin = $this->requireAdmin($request, $users, (int) $settings['club_id']);
            if ($admin instanceof JsonResponse) return $admin;
            return JsonResponse::ok([
                'registration' => $repo->checkInPlayer($tournamentId, $playerId, null, null, null, true),
            ]);
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Method not allowed.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Du må logge inn.');
        $user = $users->findBySessionToken($token);
        return $user ?? JsonResponse::error(401, 'invalid_session', 'Økten er utløpt eller ugyldig.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $user = $this->requireUser($request, $users);
        if ($user instanceof JsonResponse) return $user;
        if ((string) ($user['role'] ?? '') === 'super_admin') return $user;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return JsonResponse::error(403, 'admin_required', 'Admin-tilgang kreves.');
        $clubIds = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        if (!in_array($clubId, $clubIds, true)) return JsonResponse::error(403, 'club_access_denied', 'Du kan ikke administrere denne klubben.');
        return $user;
    }

    private function nullableFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') return null;
        if (!is_numeric($value)) throw new ValidationException('invalid_location', 'Posisjonsdata må være numeriske.');
        return (float) $value;
    }
}
