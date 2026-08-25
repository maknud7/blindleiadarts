<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\PlayerBreakRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class PlayerBreakApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if (!in_array($request->method(), ['GET', 'POST'], true)
            || preg_match('#^v1/tournaments/(\d+)/me/break$#', $path) !== 1) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $response = $this->dispatch($request, $path, $database);
        } catch (ValidationException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
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

    private function dispatch(Request $request, string $path, Database $database): JsonResponse
    {
        preg_match('#^v1/tournaments/(\d+)/me/break$#', $path, $matches);
        $tournamentId = (int) ($matches[1] ?? 0);
        $users = new UserAccountRepository($database);
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Du må være logget inn for å bruke spillerpause.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        $playerId = (int) ($user['player_id'] ?? 0);
        if ($playerId <= 0) {
            return JsonResponse::error(422, 'player_profile_missing', 'Kontoen er ikke koblet til en spillerprofil.');
        }

        $breaks = new PlayerBreakRepository($database);
        if ($request->method() === 'POST') {
            return JsonResponse::ok(['break' => $breaks->requestBreak($tournamentId, $playerId)], 201);
        }
        return JsonResponse::ok([
            'break' => $breaks->getStatus($tournamentId, $playerId),
            'break_minutes' => PlayerBreakRepository::BREAK_MINUTES,
        ]);
    }
}
