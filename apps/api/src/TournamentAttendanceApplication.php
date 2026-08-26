<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\UserAccountRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use mysqli_sql_exception;
use Throwable;

final class TournamentAttendanceApplication
{
    private const MIN_PLAYERS = 4;

    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        $method = $request->method();

        $guest = $method === 'POST' && preg_match('#^v1/tournaments/(\d+)/registrations/guest$#', $path, $guestMatch) === 1;
        $finish = $method === 'POST' && preg_match('#^v1/tournaments/(\d+)/finish-checkin$#', $path, $finishMatch) === 1;
        $legacyAdminRegistration = $method === 'POST' && preg_match('#^v1/tournaments/(\d+)/registrations$#', $path, $legacyMatch) === 1;
        $startGuard = $method === 'POST' && preg_match('#^v1/tournaments/(\d+)/start$#', $path, $startMatch) === 1;

        if (!$guest && !$finish && !$legacyAdminRegistration && !$startGuard) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $connection = $database->connection();
            $prefix = $database->tablePrefix();
            $users = new UserAccountRepository($database);

            $tournamentId = (int) (($guestMatch[1] ?? $finishMatch[1] ?? $legacyMatch[1] ?? $startMatch[1]) ?? 0);
            $tournament = $this->findTournament($connection, $prefix, $tournamentId);
            if ($tournament === null) {
                $response = JsonResponse::error(404, 'tournament_not_found', 'Turneringen ble ikke funnet.');
            } else {
                $admin = $this->requireAdmin($request, $users, (int) $tournament['club_id']);
                if ($admin instanceof JsonResponse) {
                    $response = $admin;
                } elseif ($guest) {
                    $response = JsonResponse::ok([
                        'registration' => $this->addGuest($connection, $prefix, $tournament, $request->jsonBody()),
                    ], 201);
                } elseif ($finish) {
                    $response = JsonResponse::ok([
                        'attendance' => $this->finishCheckin($connection, $prefix, $tournament),
                    ]);
                } elseif ($legacyAdminRegistration) {
                    $response = JsonResponse::error(
                        409,
                        'self_registration_required',
                        'Registrerte spillere melder seg på selv. Bruk «Legg til gjest» for en spiller som ikke er registrert.'
                    );
                } else {
                    $this->assertStartAllowed($connection, $prefix, $tournament);
                    return false;
                }
            }
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

    /** @return array<string,mixed>|null */
    private function findTournament(mysqli $connection, string $prefix, int $tournamentId): ?array
    {
        $stmt = $connection->prepare(sprintf(
            'SELECT id,club_id,name,status,max_players FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string,mixed> $tournament @param array<string,mixed> $payload @return array<string,mixed> */
    private function addGuest(mysqli $connection, string $prefix, array $tournament, array $payload): array
    {
        if ((string) $tournament['status'] !== 'draft') {
            throw new ValidationException('checkin_closed', 'Innsjekken er avsluttet.', 409);
        }

        $firstName = trim((string) ($payload['first_name'] ?? ''));
        $lastName = trim((string) ($payload['last_name'] ?? ''));
        if ($firstName === '' || $lastName === '') {
            throw new ValidationException('guest_name_required', 'Fornavn og etternavn må fylles ut.');
        }
        if (mb_strlen($firstName) > 120 || mb_strlen($lastName) > 120) {
            throw new ValidationException('guest_name_too_long', 'Navnet er for langt.');
        }

        $tournamentId = (int) $tournament['id'];
        $displayName = trim($firstName . ' ' . $lastName);

        $duplicate = $connection->prepare(sprintf(
            'SELECT tp.id
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             WHERE tp.tournament_id=? AND tp.status NOT IN ("withdrawn","no_show")
               AND LOWER(p.first_name)=LOWER(?) AND LOWER(p.last_name)=LOWER(?)
             LIMIT 1',
            $prefix
        ));
        $duplicate->bind_param('iss', $tournamentId, $firstName, $lastName);
        $duplicate->execute();
        $alreadyExists = $duplicate->get_result()->fetch_assoc() !== null;
        $duplicate->close();
        if ($alreadyExists) {
            throw new ValidationException('guest_already_added', 'Denne spilleren er allerede lagt til i turneringen.', 409);
        }

        $maxPlayers = $tournament['max_players'] !== null ? (int) $tournament['max_players'] : null;
        if ($maxPlayers !== null && $this->activeCount($connection, $prefix, $tournamentId) >= $maxPlayers) {
            throw new ValidationException('tournament_full', 'Turneringen har nådd maks antall spillere.', 409);
        }

        $connection->begin_transaction();
        try {
            // A guest has no club membership/account. The player row remains only so
            // matches and statistics keep a stable canonical player id.
            $player = $connection->prepare(sprintf(
                'INSERT INTO `%1$splayers` (club_id,display_name,first_name,last_name,is_active)
                 VALUES (NULL,?,?,?,1)',
                $prefix
            ));
            $player->bind_param('sss', $displayName, $firstName, $lastName);
            $player->execute();
            $playerId = (int) $player->insert_id;
            $player->close();

            $source = 'guest_admin';
            $checkinSource = 'admin_guest';
            $registration = $connection->prepare(sprintf(
                'INSERT INTO `%1$stournament_players`
                 (tournament_id,player_id,status,registration_source,checked_in_at,checkin_source)
                 VALUES (?, ?, "checked_in", ?, NOW(3), ?)',
                $prefix
            ));
            $registration->bind_param('iiss', $tournamentId, $playerId, $source, $checkinSource);
            $registration->execute();
            $registrationId = (int) $registration->insert_id;
            $registration->close();

            $connection->commit();
        } catch (Throwable $error) {
            $connection->rollback();
            throw $error;
        }

        return [
            'id' => $registrationId,
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'display_name' => $displayName,
            'first_name' => $firstName,
            'last_name' => $lastName,
            'status' => 'checked_in',
            'registration_source' => 'guest_admin',
        ];
    }

    /** @param array<string,mixed> $tournament @return array<string,mixed> */
    private function finishCheckin(mysqli $connection, string $prefix, array $tournament): array
    {
        $tournamentId = (int) $tournament['id'];
        $status = (string) $tournament['status'];

        if ($status === 'ready') {
            return [
                'tournament_id' => $tournamentId,
                'status' => 'ready',
                'checked_in_count' => $this->checkedCount($connection, $prefix, $tournamentId),
                'already_finished' => true,
            ];
        }
        if ($status !== 'draft') {
            throw new ValidationException('checkin_closed', 'Innsjekken er allerede avsluttet.', 409);
        }

        $checked = $this->checkedCount($connection, $prefix, $tournamentId);
        if ($checked < self::MIN_PLAYERS) {
            throw new ValidationException(
                'not_enough_checked_in_players',
                'Minst fire spillere må være sjekket inn før du kan gå videre.'
            );
        }

        $connection->begin_transaction();
        try {
            $noShows = $connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET status="no_show",seed=NULL,seed_rating=NULL,seed_rating_source=NULL
                 WHERE tournament_id=? AND status IN ("registered","paused")',
                $prefix
            ));
            $noShows->bind_param('i', $tournamentId);
            $noShows->execute();
            $noShowCount = $noShows->affected_rows;
            $noShows->close();

            $waitlist = $connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET status="withdrawn",seed=NULL,seed_rating=NULL,seed_rating_source=NULL
                 WHERE tournament_id=? AND status="waitlisted"',
                $prefix
            ));
            $waitlist->bind_param('i', $tournamentId);
            $waitlist->execute();
            $waitlistCount = $waitlist->affected_rows;
            $waitlist->close();

            $finish = $connection->prepare(sprintf(
                'UPDATE `%1$stournaments`
                 SET status="ready",checkin_closes_at=NOW(),registration_closes_at=NOW()
                 WHERE id=? AND status="draft"',
                $prefix
            ));
            $finish->bind_param('i', $tournamentId);
            $finish->execute();
            $finish->close();

            $connection->commit();
        } catch (Throwable $error) {
            $connection->rollback();
            throw $error;
        }

        return [
            'tournament_id' => $tournamentId,
            'status' => 'ready',
            'checked_in_count' => $checked,
            'no_show_count' => $noShowCount,
            'withdrawn_waitlist_count' => $waitlistCount,
            'already_finished' => false,
        ];
    }

    /** @param array<string,mixed> $tournament */
    private function assertStartAllowed(mysqli $connection, string $prefix, array $tournament): void
    {
        $status = (string) $tournament['status'];
        if ($status === 'in_progress') {
            return;
        }
        if ($status !== 'ready') {
            throw new ValidationException('checkin_must_be_finished', 'Avslutt innsjekken før turneringen startes.', 409);
        }
        $checked = $this->checkedCount($connection, $prefix, (int) $tournament['id']);
        if ($checked < self::MIN_PLAYERS) {
            throw new ValidationException('not_enough_checked_in_players', 'Minst fire spillere må delta i turneringen.');
        }
    }

    private function checkedCount(mysqli $connection, string $prefix, int $tournamentId): int
    {
        $stmt = $connection->prepare(sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$stournament_players` WHERE tournament_id=? AND status="checked_in"',
            $prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }

    private function activeCount(mysqli $connection, string $prefix, int $tournamentId): int
    {
        $stmt = $connection->prepare(sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$stournament_players`
             WHERE tournament_id=? AND status IN ("registered","checked_in","waitlisted","paused")',
            $prefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }

    /** @return array<string,mixed>|JsonResponse */
    private function requireAdmin(Request $request, UserAccountRepository $users, int $clubId): array|JsonResponse
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return JsonResponse::error(401, 'authentication_required', 'Du må logge inn.');
        }
        $user = $users->findBySessionToken($token);
        if ($user === null) {
            return JsonResponse::error(401, 'invalid_session', 'Økten er utløpt eller ugyldig.');
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
        return in_array($clubId, $clubIds, true)
            ? $user
            : JsonResponse::error(403, 'club_access_denied', 'Du kan ikke administrere denne klubben.');
    }
}
