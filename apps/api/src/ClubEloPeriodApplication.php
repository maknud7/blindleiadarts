<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ClubEloPeriodRepository;
use Blindleia\Dartkiosk\Api\Repository\ClubEloReadRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

/** A separate club ELO lifecycle, independent of competitive seasons. */
final class ClubEloPeriodApplication
{
    public function __construct(private readonly string $rootPath) {}

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $method = $request->method();
        $path = trim($request->path(), '/');
        if (!$this->handles($method, $path)) return false;

        try {
            $database = new Database(Config::load($this->rootPath));
            $periods = new ClubEloPeriodRepository($database);
            $ratings = new ClubEloReadRepository($database);
            $users = new UserAccountRepository($database);
            $result = $this->dispatch($request, $method, $path, $periods, $ratings, $users);
        } catch (ValidationException $e) {
            $result = JsonResponse::error($e->statusCode(), $e->errorCode(), $e->getMessage());
        } catch (mysqli_sql_exception) {
            $result = JsonResponse::error(500, 'database_error', 'Kunne ikke hente eller lagre ELO.');
        } catch (Throwable) {
            $result = JsonResponse::error(500, 'internal_server_error', 'ELO-forespørselen mislyktes.');
        }
        $result->send();
        return true;
    }

    public function handles(string $method, string $path): bool
    {
        return (
            ($method === 'GET' && preg_match('#^v1/clubs/[1-9][0-9]*/club-elo$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/players/[1-9][0-9]*/club-elo-tournaments$#', $path) === 1)
            || (in_array($method, ['GET','POST'], true) && preg_match('#^v1/clubs/[1-9][0-9]*/elo-periods$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/clubs/[1-9][0-9]*/elo-periods/rollover$#', $path) === 1)
            || (in_array($method, ['GET','PATCH'], true) && preg_match('#^v1/elo-periods/[1-9][0-9]*$#', $path) === 1)
        );
    }

    private function dispatch(
        Request $request,
        string $method,
        string $path,
        ClubEloPeriodRepository $periods,
        ClubEloReadRepository $ratings,
        UserAccountRepository $users
    ): JsonResponse {
        if ($method === 'GET' && preg_match('#^v1/clubs/([1-9][0-9]*)/club-elo$#', $path, $m)) {
            $clubId = (int) $m[1];
            return JsonResponse::ok(['club_id' => $clubId] + $ratings->clubRanking($clubId));
        }
        if ($method === 'GET' && preg_match('#^v1/players/([1-9][0-9]*)/club-elo-tournaments$#', $path, $m)) {
            $period = filter_input(INPUT_GET, 'period_id', FILTER_VALIDATE_INT,
                ['options' => ['min_range' => 1]]) ?: null;
            $result = $ratings->playerTournaments((int) $m[1], $period);
            return $result === null
                ? JsonResponse::error(404, 'player_not_found', 'Spilleren finnes ikke.')
                : JsonResponse::ok($result);
        }
        if (preg_match('#^v1/clubs/([1-9][0-9]*)/elo-periods$#', $path, $m)) {
            $clubId = (int) $m[1];
            if ($method === 'GET') {
                return JsonResponse::ok([
                    'club_id' => $clubId,
                    'items' => $periods->listForClub($clubId),
                    'current' => $periods->current($clubId),
                ]);
            }
            $error = $this->requireClubAdmin($request, $users, $clubId);
            if ($error !== null) return $error;
            return JsonResponse::ok(['period' => $periods->createFirst($clubId, $request->jsonBody())], 201);
        }
        if ($method === 'POST' && preg_match('#^v1/clubs/([1-9][0-9]*)/elo-periods/rollover$#', $path, $m)) {
            $clubId = (int) $m[1];
            $error = $this->requireClubAdmin($request, $users, $clubId);
            if ($error !== null) return $error;
            return JsonResponse::ok($periods->rollover($clubId, $request->jsonBody()), 201);
        }
        if (preg_match('#^v1/elo-periods/([1-9][0-9]*)$#', $path, $m)) {
            $period = $periods->find((int) $m[1]);
            if ($period === null) return JsonResponse::error(404, 'elo_period_not_found', 'ELO-perioden finnes ikke.');
            if ($method === 'GET') return JsonResponse::ok(['period' => $period]);
            $error = $this->requireClubAdmin($request, $users, (int) $period['club_id']);
            if ($error !== null) return $error;
            $body = $request->jsonBody();
            return JsonResponse::ok(['period' => $periods->rename((int) $period['id'], $body['name'] ?? '')]);
        }
        return JsonResponse::error(405, 'method_not_allowed', 'Metoden støttes ikke.');
    }

    private function requireClubAdmin(Request $request, UserAccountRepository $users, int $clubId): ?JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        $user = $users->findBySessionToken($token);
        if ($user === null) return JsonResponse::error(401, 'invalid_session', 'Sesjonen er ugyldig eller utløpt.');
        if ($user['role'] === 'super_admin') return null;
        if ($user['role'] !== 'club_admin') {
            return JsonResponse::error(403, 'admin_required', 'Klubbadministrator kreves.');
        }
        $clubIds = array_values(array_filter(array_map(
            'intval', explode(',', (string) ($user['admin_club_ids'] ?? ''))
        )));
        return in_array($clubId, $clubIds, true) ? null
            : JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til denne klubben.');
    }
}
