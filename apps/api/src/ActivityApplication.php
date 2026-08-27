<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ActivityRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class ActivityApplication
{
    public function __construct(private string $rootPath)
    {
        $this->rootPath = rtrim($this->rootPath, '/\\');
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        $method = $request->method();

        $record = $method === 'POST' && $path === 'v1/activity';
        $clubSummary = $method === 'GET' && preg_match('#^v1/clubs/\d+/activity$#', $path) === 1;
        $platformSummary = $method === 'GET' && $path === 'v1/platform/activity';
        if (!$record && !$clubSummary && !$platformSummary) {
            return false;
        }

        $config = null;
        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $events = new ActivityRepository($database);
            $users = new UserAccountRepository($database);
            if ($record) {
                $response = $this->record($request, $events, $users);
            } elseif ($platformSummary) {
                $response = $this->platformSummary($request, $events, $users);
            } else {
                $response = $this->summary($request, $path, $events, $users);
            }
        } catch (mysqli_sql_exception $error) {
            $response = JsonResponse::error(500, 'activity_database_error', 'Aktivitetslogging er midlertidig utilgjengelig.', [
                'details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
            ]);
        } catch (Throwable $error) {
            $response = JsonResponse::error(500, 'activity_internal_error', 'Aktivitetslogging er midlertidig utilgjengelig.', [
                'details' => $config instanceof Config && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
            ]);
        }

        $response->send();
        return true;
    }

    private function record(Request $request, ActivityRepository $events, UserAccountRepository $users): JsonResponse
    {
        $payload = $request->jsonBody();
        $batch = is_array($payload['events'] ?? null) ? $payload['events'] : [$payload];
        $batch = array_values(array_filter($batch, 'is_array'));
        if ($batch === []) {
            return JsonResponse::error(422, 'activity_events_required', 'Ingen aktivitet å registrere.');
        }

        $user = null;
        $token = $request->bearerToken();
        if ($token !== null) {
            $user = $users->findBySessionToken($token);
        }
        $userId = is_array($user) && isset($user['id']) ? (int) $user['id'] : null;
        $sessionId = is_array($user) && isset($user['session_id']) ? (int) $user['session_id'] : null;

        $count = $events->recordBatch($batch, $userId, $sessionId);
        return JsonResponse::ok(['recorded' => $count], 201);
    }

    private function summary(Request $request, string $path, ActivityRepository $events, UserAccountRepository $users): JsonResponse
    {
        preg_match('#^v1/clubs/(\d+)/activity$#', $path, $m);
        $clubId = (int) ($m[1] ?? 0);
        $user = $this->authenticatedUser($request, $users);
        if ($user instanceof JsonResponse) return $user;
        if (!$this->canManageClub($user, $clubId)) {
            return JsonResponse::error(403, 'club_access_denied', 'Du har ikke tilgang til aktivitetsdata for denne klubben.');
        }

        $days = isset($_GET['days']) && is_numeric($_GET['days']) ? (int) $_GET['days'] : 30;
        return JsonResponse::ok($events->summaryByClub($clubId, $days));
    }

    private function platformSummary(Request $request, ActivityRepository $events, UserAccountRepository $users): JsonResponse
    {
        $user = $this->authenticatedUser($request, $users);
        if ($user instanceof JsonResponse) return $user;
        if ((string) ($user['role'] ?? '') !== 'super_admin') {
            return JsonResponse::error(403, 'super_admin_required', 'Superadmin-tilgang kreves for plattformlogger.');
        }
        $days = isset($_GET['days']) && is_numeric($_GET['days']) ? (int) $_GET['days'] : 30;
        return JsonResponse::ok($events->summaryAll($days));
    }

    /** @return array<string,mixed>|JsonResponse */
    private function authenticatedUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Innlogging kreves.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Innloggingen er utløpt eller ugyldig.');
        }
        return $user;
    }

    /** @param array<string,mixed> $user */
    private function canManageClub(array $user, int $clubId): bool
    {
        if ((string) ($user['role'] ?? '') === 'super_admin') return true;
        if ((string) ($user['role'] ?? '') !== 'club_admin') return false;
        $ids = array_values(array_filter(array_map('intval', explode(',', (string) ($user['admin_club_ids'] ?? '')))));
        return in_array($clubId, $ids, true);
    }
}
