<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\ClubRepository;
use Blindleia\Dartkiosk\Api\Repository\ScreenRepository;
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
        if (!$this->handles($request->method(), $path)) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $repo = new TournamentCheckinRepository($database);
            $users = new UserAccountRepository($database);
            $screens = new ScreenRepository($database);
            $clubs = new ClubRepository($database);
            $response = $this->dispatch($request, $path, $repo, $users, $screens, $clubs, $database);
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

    private function handles(string $method, string $path): bool
    {
        return ($method === 'POST' && preg_match('#^v1/tournaments/\d+/check-in$#', $path) === 1)
            || ($method === 'GET' && preg_match('#^v1/tournaments/\d+/check-in-status$#', $path) === 1)
            || ($method === 'GET' && $path === 'v1/public/check-in-display')
            || (in_array($method, ['GET', 'PATCH', 'PUT'], true) && preg_match('#^v1/clubs/\d+/checkin-settings$#', $path) === 1)
            || (in_array($method, ['GET', 'PATCH', 'PUT'], true) && preg_match('#^v1/tournaments/\d+/checkin-settings$#', $path) === 1)
            || ($method === 'POST' && preg_match('#^v1/tournaments/\d+/checkin-code/rotate$#', $path) === 1)
            || (in_array($method, ['POST', 'DELETE'], true) && preg_match('#^v1/tournaments/\d+/admin-check-in/\d+$#', $path) === 1);
    }

    private function dispatch(
        Request $request,
        string $path,
        TournamentCheckinRepository $repo,
        UserAccountRepository $users,
        ScreenRepository $screens,
        ClubRepository $clubs,
        Database $database
    ): JsonResponse {
        $method = $request->method();

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/check-in$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                return $user;
            }
            $tournamentId = (int) $m[1];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            }
            if ($this->checkinLocked($settings)) {
                return $this->checkinLockedResponse();
            }
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'Kontoen er ikke koblet til en spillerprofil.');
            }
            $payload = $request->jsonBody();
            return JsonResponse::ok([
                'registration' => $repo->checkInPlayer(
                    $tournamentId,
                    $playerId,
                    false,
                    isset($payload['code']) ? (string) $payload['code'] : null,
                    false
                ),
            ]);
        }

        if ($method === 'GET' && preg_match('#^v1/tournaments/(\d+)/check-in-status$#', $path, $m) === 1) {
            $user = $this->requireUser($request, $users);
            if ($user instanceof JsonResponse) {
                return $user;
            }
            $playerId = (int) ($user['player_id'] ?? 0);
            if ($playerId <= 0) {
                return JsonResponse::error(422, 'player_profile_missing', 'Kontoen er ikke koblet til en spillerprofil.');
            }
            $status = $repo->statusForPlayer((int) $m[1], $playerId);
            $settings = $repo->getTournamentSettings((int) $m[1]);
            if ($settings !== null && $this->checkinLocked($settings)) {
                $status['window_state'] = 'closed';
                $status['code_allowed'] = false;
                $status['admin_checkin_allowed'] = false;
            }
            return JsonResponse::ok($status);
        }

        if ($method === 'GET' && $path === 'v1/public/check-in-display') {
            $screenToken = trim((string) ($_GET['screen_token'] ?? ''));
            $clubSlug = trim((string) ($_GET['club_slug'] ?? ''));
            $clubId = 0;

            if ($screenToken !== '') {
                $screen = $screens->resolveByAccessToken($screenToken);
                $clubId = (int) ($screen['club']['id'] ?? 0);
                if ($clubId <= 0) {
                    return JsonResponse::error(401, 'screen_token_invalid', 'Skjermtoken er ugyldig.');
                }
            } elseif ($clubSlug !== '') {
                $club = $clubs->findBySlug($clubSlug);
                $clubId = (int) ($club['id'] ?? 0);
                if ($clubId <= 0) {
                    return JsonResponse::error(404, 'club_not_found', 'Klubben ble ikke funnet.');
                }
            } else {
                return JsonResponse::error(422, 'checkin_display_context_required', 'Oppgi skjermtoken eller klubb.');
            }

            $display = $repo->publicDisplayForClub($clubId);
            if ($display !== null) {
                $settings = $repo->getTournamentSettings((int) ($display['tournament_id'] ?? 0));
                if ($settings === null || $this->checkinLocked($settings)) {
                    $display = null;
                }
            }
            return JsonResponse::ok([
                'active' => $display !== null,
                'checkin' => $display,
            ]);
        }

        if (preg_match('#^v1/clubs/(\d+)/checkin-settings$#', $path, $m) === 1) {
            $clubId = (int) $m[1];
            $admin = $this->requireAdmin($request, $users, $clubId);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            if ($method === 'GET') {
                return JsonResponse::ok(['settings' => $repo->getClubSettings($clubId)]);
            }
            return JsonResponse::ok([
                'settings' => $repo->updateClubSettings($clubId, $request->jsonBody(), (int) $admin['id']),
            ]);
        }

        if (preg_match('#^v1/tournaments/(\d+)/checkin-settings$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $settings['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            if ($method === 'GET') {
                return JsonResponse::ok(['settings' => $settings]);
            }
            if ($this->checkinLocked($settings)) {
                return $this->checkinLockedResponse();
            }
            return JsonResponse::ok([
                'settings' => $repo->updateTournamentSettings($tournamentId, $request->jsonBody()),
            ]);
        }

        if ($method === 'POST' && preg_match('#^v1/tournaments/(\d+)/checkin-code/rotate$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $settings['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            if ($this->checkinLocked($settings)) {
                return $this->checkinLockedResponse();
            }
            return JsonResponse::ok(['settings' => $repo->rotateTournamentCode($tournamentId)]);
        }

        if (preg_match('#^v1/tournaments/(\d+)/admin-check-in/(\d+)$#', $path, $m) === 1) {
            $tournamentId = (int) $m[1];
            $playerId = (int) $m[2];
            $settings = $repo->getTournamentSettings($tournamentId);
            if ($settings === null) {
                return JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            }
            $admin = $this->requireAdmin($request, $users, (int) $settings['club_id']);
            if ($admin instanceof JsonResponse) {
                return $admin;
            }
            if ($this->checkinLocked($settings)) {
                return $this->checkinLockedResponse();
            }

            if ($method === 'POST') {
                return JsonResponse::ok([
                    'registration' => $repo->checkInPlayer(
                        $tournamentId,
                        $playerId,
                        true,
                        null,
                        false
                    ),
                ]);
            }

            if ($method === 'DELETE') {
                return JsonResponse::ok([
                    'registration' => $this->adminCheckOut($database, $tournamentId, $playerId),
                ]);
            }
        }

        return JsonResponse::error(405, 'method_not_allowed', 'Method not allowed.');
    }

    /** @return array<string,mixed> */
    private function adminCheckOut(Database $database, int $tournamentId, int $playerId): array
    {
        $connection = $database->connection();
        $prefix = $database->tablePrefix();
        $stmt = $connection->prepare(sprintf(
            'SELECT id,status FROM `%1$stournament_players` WHERE tournament_id=? AND player_id=? LIMIT 1',
            $prefix
        ));
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $registration = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($registration === null) {
            throw new ValidationException('registration_not_found', 'Påmeldingen ble ikke funnet.', 404);
        }
        if ((string) $registration['status'] !== 'checked_in') {
            throw new ValidationException('registration_not_checked_in', 'Spilleren er ikke sjekket inn.', 409);
        }

        $stmt = $connection->prepare(sprintf(
            'UPDATE `%1$stournament_players` SET status="registered",checked_in_at=NULL,checkin_source=NULL WHERE id=?',
            $prefix
        ));
        $registrationId = (int) $registration['id'];
        $stmt->bind_param('i', $registrationId);
        $stmt->execute();
        $stmt->close();

        return [
            'id' => $registrationId,
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'status' => 'registered',
            'checked_in_at' => null,
            'checkin_source' => null,
        ];
    }

    /** @param array<string,mixed> $settings */
    private function checkinLocked(array $settings): bool
    {
        return in_array((string) ($settings['status'] ?? ''), ['in_progress', 'completed', 'archived'], true);
    }

    private function checkinLockedResponse(): JsonResponse
    {
        return JsonResponse::error(409, 'checkin_tournament_started', 'Innsjekk er stengt fordi turneringen er startet.');
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireUser(Request $request, UserAccountRepository $users): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Du må logge inn.');
        }
        $user = $users->findBySessionToken($token);
        return $user ?? JsonResponse::error(401, 'invalid_session', 'Økten er utløpt eller ugyldig.');
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
            return JsonResponse::error(403, 'admin_required', 'Admin-tilgang kreves.');
        }
        $clubIds = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($user['admin_club_ids'] ?? ''))
        )));
        if (!in_array($clubId, $clubIds, true)) {
            return JsonResponse::error(403, 'club_access_denied', 'Du kan ikke administrere denne klubben.');
        }
        return $user;
    }
}
