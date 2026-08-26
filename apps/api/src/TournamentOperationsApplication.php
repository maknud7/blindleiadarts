<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskAccessException;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentLiveRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentMatchEngineRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentOperationsRepository;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli_sql_exception;
use Throwable;

final class TournamentOperationsApplication
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
            $response = $this->dispatch($request, $path, $config, $database);
        } catch (KioskAccessException $error) {
            $response = JsonResponse::error($error->statusCode(), $error->errorCode(), $error->getMessage());
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

    private function handles(string $method, string $path): bool
    {
        return ($method === 'GET' && preg_match('#^v1/public/clubs/[^/]+/live$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/public/tournaments/\d+/live$#', $path) === 1)
            || preg_match('#^v1/tournaments/\d+/operations(?:/(reconcile|settings|boards))?$#', $path) === 1
            || ($method === 'GET' && preg_match('#^v1/kiosks/[^/]+/post-match$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/kiosks/[^/]+/(next-match|release-next-match)$#', $path) === 1);
    }

    private function dispatch(Request $request, string $path, Config $config, Database $database): JsonResponse
    {
        $method = $request->method();
        $operations = new TournamentOperationsRepository($database);
        $engine = new TournamentMatchEngineRepository($database);

        if ($method === 'GET' && preg_match('#^v1/public/clubs/([^/]+)/live$#', $path, $m) === 1) {
            $live = (new TournamentLiveRepository($database))->byClubSlug(urldecode((string) $m[1]));
            return $live === null
                ? JsonResponse::error(404, 'live_tournament_not_found', 'No current tournament was found for this club.')
                : JsonResponse::ok($live);
        }

        if ($method === 'GET' && preg_match('#^v1/public/tournaments/(\d+)/live$#', $path, $m) === 1) {
            $live = (new TournamentLiveRepository($database))->byTournamentId((int) $m[1]);
            return $live === null
                ? JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.')
                : JsonResponse::ok($live);
        }

        if (preg_match('#^v1/tournaments/(\d+)/operations(?:/(reconcile|settings|boards))?$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $tournament = $operations->findTournament($tournamentId);
            if ($tournament === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            }

            $users = new UserAccountRepository($database);
            $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }

            $action = (string) ($m[2] ?? '');
            if ($method === 'GET' && $action === '') {
                return JsonResponse::ok($engine->decorateSnapshot($tournamentId, $operations->snapshot($tournamentId)));
            }
            if ($method === 'GET' && $action === 'boards') {
                return JsonResponse::ok($engine->listBoardSelection($tournamentId));
            }
            if (in_array($method, ['PUT', 'PATCH'], true) && $action === 'boards') {
                $payload = $request->jsonBody();
                $ids = is_array($payload['kiosk_ids'] ?? null) ? $payload['kiosk_ids'] : [];
                $result = $engine->updateBoardSelection($tournamentId, $ids);
                $this->publishClubRefresh($config, (int) $tournament['club_id'], 'tournament_boards_changed');
                return JsonResponse::ok($result);
            }
            if ($method === 'POST' && $action === 'reconcile') {
                $assignment = $engine->assignFreeBoards($tournamentId);
                $snapshot = $engine->decorateSnapshot($tournamentId, $operations->snapshot($tournamentId));
                $snapshot['assignment'] = $assignment;
                $this->publishClubRefresh($config, (int) $tournament['club_id'], 'tournament_operations_changed');
                return JsonResponse::ok($snapshot);
            }
            if (in_array($method, ['PUT', 'PATCH'], true) && $action === 'settings') {
                $payload = $request->jsonBody();
                if (!array_key_exists('auto_assign_enabled', $payload)) {
                    return JsonResponse::error(422, 'auto_assign_enabled_required', 'auto_assign_enabled is required.');
                }
                $operations->updateAutoAssignEnabled($tournamentId, (bool) $payload['auto_assign_enabled']);
                $result = $engine->decorateSnapshot($tournamentId, $operations->snapshot($tournamentId));
                $this->publishClubRefresh($config, (int) $tournament['club_id'], 'tournament_operations_settings_changed');
                return JsonResponse::ok($result);
            }
            return JsonResponse::error(405, 'method_not_allowed', 'Method is not supported for this operations route.');
        }

        if (preg_match('#^v1/kiosks/([^/]+)/(post-match|next-match|release-next-match)$#', $path, $m) === 1) {
            $code = urldecode((string) $m[1]);
            $action = (string) $m[2];
            $kiosks = new KioskRepository($database);
            $pairingToken = $request->header('x-kiosk-pairing-token');
            $state = $kiosks->findKioskStateByCode($code, $pairingToken);
            if ($state === null) {
                return JsonResponse::error(404, 'kiosk_not_found', 'No kiosk exists for the supplied kiosk code.');
            }
            $kiosk = is_array($state['kiosk'] ?? null) ? $state['kiosk'] : [];
            $kioskId = (int) ($kiosk['id'] ?? 0);
            if ($kioskId <= 0) {
                return JsonResponse::error(409, 'kiosk_state_invalid', 'Kiosk state is missing its canonical id.');
            }

            if ($method === 'GET' && $action === 'post-match') {
                $postMatch = $engine->kioskPostMatch($kioskId);
                if (($postMatch['active_match'] ?? false) !== true
                    && is_array($postMatch['last_completed_match'] ?? null)
                    && !is_array($postMatch['reservation'] ?? null)
                    && (int) ($postMatch['remaining_seconds'] ?? 0) > 0) {
                    $engine->reserveNextForKiosk($kioskId);
                    $postMatch = $engine->kioskPostMatch($kioskId);
                }
                return JsonResponse::ok($postMatch);
            }

            if ($method === 'POST' && $action === 'release-next-match') {
                $engine->releaseReservationForKiosk($kioskId);
                return JsonResponse::ok(['released' => true]);
            }

            if ($method === 'POST' && $action === 'next-match') {
                $assignment = $engine->assignNextToKiosk($kioskId);
                $after = $kiosks->findKioskStateByCode($code, $pairingToken);
                $club = is_array($kiosk['club'] ?? null) ? $kiosk['club'] : [];
                $clubId = (int) ($club['id'] ?? 0);
                if ($clubId > 0 && ($assignment['assigned'] ?? false) === true) {
                    $this->publishClubRefresh($config, $clubId, 'board_ready_for_next_match');
                }
                return JsonResponse::ok(['assignment' => $assignment, 'state' => $after]);
            }
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Method is not supported for this operations route.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Authentication is required.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Session is invalid or expired.');
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
        return in_array($clubId, $clubIds, true)
            ? $user
            : JsonResponse::error(403, 'club_access_denied', 'You cannot manage this club.');
    }

    private function publishClubRefresh(Config $config, int $clubId, string $reason): void
    {
        if (!$config->realtimePublishEnabled() || $clubId <= 0) {
            return;
        }
        $body = json_encode([
            'secret' => $config->realtimePublishSecret(),
            'channels' => ['club:' . $clubId],
            'event' => 'snapshot',
            'payload' => ['refresh' => true, 'reason' => $reason],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($body === false) {
            return;
        }
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\nConnection: close",
                'content' => $body,
                'timeout' => 1.5,
                'ignore_errors' => true,
            ],
        ]);
        try {
            @file_get_contents($config->realtimePublishUrl(), false, $context);
        } catch (Throwable) {
            // Realtime is best effort; canonical operations must not depend on it.
        }
    }
}
