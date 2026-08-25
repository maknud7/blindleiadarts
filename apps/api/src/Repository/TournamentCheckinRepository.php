<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use DateTimeZone;
use mysqli;

final class TournamentCheckinRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed> */
    public function getClubSettings(int $clubId): array
    {
        $stmt = $this->connection->prepare(sprintf('SELECT * FROM `%1$sclub_checkin_settings` WHERE club_id=? LIMIT 1', $this->tablePrefix));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();
        return array_merge([
            'club_id' => $clubId,
            'venue_latitude' => null,
            'venue_longitude' => null,
            'onsite_radius_meters' => 150,
            'opens_minutes_before_start' => 60,
            'closes_minutes_after_start' => 10,
            'require_geolocation' => 1,
            'max_location_accuracy_meters' => 250,
        ], $row);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubSettings(int $clubId, array $payload, int $userId): array
    {
        $current = $this->getClubSettings($clubId);
        $lat = $this->nullableFloat($payload['venue_latitude'] ?? $current['venue_latitude']);
        $lng = $this->nullableFloat($payload['venue_longitude'] ?? $current['venue_longitude']);
        if (($lat === null) xor ($lng === null)) {
            throw new ValidationException('checkin_coordinates_incomplete', 'Både breddegrad og lengdegrad må settes for arenaen.');
        }
        if ($lat !== null && ($lat < -90 || $lat > 90)) throw new ValidationException('invalid_venue_latitude', 'Ugyldig breddegrad.');
        if ($lng !== null && ($lng < -180 || $lng > 180)) throw new ValidationException('invalid_venue_longitude', 'Ugyldig lengdegrad.');
        $radius = min(5000, max(20, (int) ($payload['onsite_radius_meters'] ?? $current['onsite_radius_meters'])));
        $opens = min(1440, max(0, (int) ($payload['opens_minutes_before_start'] ?? $current['opens_minutes_before_start'])));
        $closes = min(360, max(0, (int) ($payload['closes_minutes_after_start'] ?? $current['closes_minutes_after_start'])));
        $require = $this->boolInt($payload['require_geolocation'] ?? $current['require_geolocation']);
        $accuracy = min(2000, max(20, (int) ($payload['max_location_accuracy_meters'] ?? $current['max_location_accuracy_meters'])));

        $sql = sprintf(
            'INSERT INTO `%1$sclub_checkin_settings`
             (club_id,venue_latitude,venue_longitude,onsite_radius_meters,opens_minutes_before_start,
              closes_minutes_after_start,require_geolocation,max_location_accuracy_meters,updated_by_user_id)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE venue_latitude=VALUES(venue_latitude),venue_longitude=VALUES(venue_longitude),
              onsite_radius_meters=VALUES(onsite_radius_meters),opens_minutes_before_start=VALUES(opens_minutes_before_start),
              closes_minutes_after_start=VALUES(closes_minutes_after_start),require_geolocation=VALUES(require_geolocation),
              max_location_accuracy_meters=VALUES(max_location_accuracy_meters),updated_by_user_id=VALUES(updated_by_user_id)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iddiiiiii', $clubId, $lat, $lng, $radius, $opens, $closes, $require, $accuracy, $userId);
        $stmt->execute();
        $stmt->close();
        return $this->getClubSettings($clubId);
    }

    /** @return array<string,mixed>|null */
    public function getTournamentSettings(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT t.id,t.club_id,t.name,t.status,t.start_at,t.checkin_opens_at,t.checkin_closes_at,
                    t.checkin_require_onsite,t.checkin_radius_meters
             FROM `%1$stournaments` t WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $tournament = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($tournament === null) return null;
        $club = $this->getClubSettings((int) $tournament['club_id']);
        return $this->withEffectiveSettings($tournament, $club);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed>|null */
    public function updateTournamentSettings(int $tournamentId, array $payload): ?array
    {
        $current = $this->getTournamentSettings($tournamentId);
        if ($current === null) return null;
        $opensAt = array_key_exists('checkin_opens_at', $payload)
            ? $this->nullableDateTime($payload['checkin_opens_at'])
            : ($current['checkin_opens_at'] ?? null);
        $closesAt = array_key_exists('checkin_closes_at', $payload)
            ? $this->nullableDateTime($payload['checkin_closes_at'])
            : ($current['checkin_closes_at'] ?? null);
        $require = array_key_exists('checkin_require_onsite', $payload)
            ? $this->nullableBoolInt($payload['checkin_require_onsite'])
            : $this->nullableBoolInt($current['checkin_require_onsite'] ?? null);
        $radius = array_key_exists('checkin_radius_meters', $payload)
            ? $this->nullablePositiveInt($payload['checkin_radius_meters'], 20, 5000)
            : ($current['checkin_radius_meters'] !== null ? (int) $current['checkin_radius_meters'] : null);
        if ($opensAt !== null && $closesAt !== null && strtotime($opensAt) >= strtotime($closesAt)) {
            throw new ValidationException('invalid_checkin_window', 'Check-in må stenge etter at den åpner.');
        }
        $sql = sprintf(
            'UPDATE `%1$stournaments` SET checkin_opens_at=?,checkin_closes_at=?,checkin_require_onsite=?,checkin_radius_meters=? WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssiii', $opensAt, $closesAt, $require, $radius, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->getTournamentSettings($tournamentId);
    }

    /**
     * @return array<string,mixed>
     */
    public function checkInPlayer(
        int $tournamentId,
        int $playerId,
        ?float $latitude,
        ?float $longitude,
        ?float $accuracyMeters,
        bool $adminOverride = false
    ): array {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);

        $registration = $this->registration($tournamentId, $playerId);
        if ($registration === null) {
            throw new ValidationException('registration_required_before_check_in', 'Du må være påmeldt før du kan checke inn.', 422);
        }
        $status = (string) $registration['status'];
        if ($status === 'checked_in') {
            return $this->formatResult($settings, $registration, null, true);
        }
        if ($status === 'waitlisted') {
            throw new ValidationException('registration_waitlisted', 'Du står på venteliste og kan ikke checke inn før du har fått plass.', 422);
        }
        if ($status !== 'registered') {
            throw new ValidationException('registration_not_checkin_eligible', 'Denne påmeldingen kan ikke checkes inn.', 422);
        }

        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        $closes = new DateTimeImmutable((string) $settings['effective_checkin_closes_at']);
        if (!$adminOverride && $now < $opens) {
            throw new ValidationException('checkin_not_open', 'Check-in åpner ' . $opens->format('d.m.Y H:i') . '.', 409);
        }
        if (!$adminOverride && $now > $closes) {
            throw new ValidationException('checkin_closed', 'Check-in stengte ' . $closes->format('d.m.Y H:i') . '. Kontakt arrangør.', 409);
        }

        $distance = null;
        $requireOnsite = (int) $settings['effective_require_onsite'] === 1;
        if (!$adminOverride && $requireOnsite) {
            $venueLat = $this->nullableFloat($settings['venue_latitude']);
            $venueLng = $this->nullableFloat($settings['venue_longitude']);
            if ($venueLat === null || $venueLng === null) {
                throw new ValidationException('checkin_venue_not_configured', 'Arena-posisjon er ikke konfigurert. Kontakt arrangør.', 503);
            }
            if ($latitude === null || $longitude === null || $accuracyMeters === null) {
                throw new ValidationException('checkin_location_required', 'Posisjon må deles for arena-checkin.', 422);
            }
            if ($latitude < -90 || $latitude > 90 || $longitude < -180 || $longitude > 180) {
                throw new ValidationException('checkin_location_invalid', 'Telefonen returnerte en ugyldig posisjon.', 422);
            }
            $maxAccuracy = (float) $settings['max_location_accuracy_meters'];
            if ($accuracyMeters <= 0 || $accuracyMeters > $maxAccuracy) {
                throw new ValidationException('checkin_location_too_inaccurate', 'Posisjonen er for unøyaktig. Gå nærmere lokalet, slå på presis posisjon og prøv igjen.', 409);
            }
            $distance = $this->distanceMeters($venueLat, $venueLng, $latitude, $longitude);
            $radius = (float) $settings['effective_radius_meters'];
            $gpsMargin = min(30.0, max(0.0, $accuracyMeters));
            if ($distance > $radius + $gpsMargin) {
                throw new ValidationException(
                    'checkin_not_onsite',
                    sprintf('Du ser ut til å være ca. %d meter fra arenaen. Check-in virker først når du er i lokalet.', (int) round($distance)),
                    409
                );
            }
        }

        $source = $adminOverride ? 'admin_override' : ($requireOnsite ? 'player_geolocation' : 'legacy');
        $sql = sprintf(
            'UPDATE `%1$stournament_players`
             SET status="checked_in",checked_in_at=NOW(3),checkin_source=?,checkin_latitude=?,checkin_longitude=?,
                 checkin_accuracy_meters=?,checkin_distance_meters=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $registrationId = (int) $registration['id'];
        $stmt->bind_param('sddddi', $source, $latitude, $longitude, $accuracyMeters, $distance, $registrationId);
        $stmt->execute();
        $stmt->close();
        $fresh = $this->registration($tournamentId, $playerId) ?? $registration;
        return $this->formatResult($settings, $fresh, $distance, false);
    }

    /** @return array<string,mixed> */
    public function statusForPlayer(int $tournamentId, int $playerId): array
    {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        $registration = $this->registration($tournamentId, $playerId);
        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        $closes = new DateTimeImmutable((string) $settings['effective_checkin_closes_at']);
        $windowState = $now < $opens ? 'not_open' : ($now > $closes ? 'closed' : 'open');
        return [
            'tournament_id' => $tournamentId,
            'registration_status' => $registration['status'] ?? null,
            'window_state' => $windowState,
            'opens_at' => $settings['effective_checkin_opens_at'],
            'closes_at' => $settings['effective_checkin_closes_at'],
            'require_onsite' => (int) $settings['effective_require_onsite'] === 1,
            'radius_meters' => (int) $settings['effective_radius_meters'],
            'venue_configured' => $settings['venue_latitude'] !== null && $settings['venue_longitude'] !== null,
        ];
    }

    /** @param array<string,mixed> $tournament @param array<string,mixed> $club @return array<string,mixed> */
    private function withEffectiveSettings(array $tournament, array $club): array
    {
        $startAt = trim((string) ($tournament['start_at'] ?? ''));
        if ($startAt === '') {
            throw new ValidationException('checkin_start_time_required', 'Turneringen må ha starttid før check-in kan konfigureres.', 422);
        }
        $start = new DateTimeImmutable($startAt);
        $opens = $tournament['checkin_opens_at'] ?: $start->modify('-' . (int) $club['opens_minutes_before_start'] . ' minutes')->format('Y-m-d H:i:s');
        $closes = $tournament['checkin_closes_at'] ?: $start->modify('+' . (int) $club['closes_minutes_after_start'] . ' minutes')->format('Y-m-d H:i:s');
        $require = $tournament['checkin_require_onsite'] === null ? (int) $club['require_geolocation'] : (int) $tournament['checkin_require_onsite'];
        $radius = $tournament['checkin_radius_meters'] === null ? (int) $club['onsite_radius_meters'] : (int) $tournament['checkin_radius_meters'];
        return array_merge($tournament, $club, [
            'effective_checkin_opens_at' => $opens,
            'effective_checkin_closes_at' => $closes,
            'effective_require_onsite' => $require,
            'effective_radius_meters' => $radius,
        ]);
    }

    /** @return array<string,mixed>|null */
    private function registration(int $tournamentId, int $playerId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,tournament_id,player_id,status,checked_in_at,checkin_source,checkin_distance_meters
             FROM `%1$stournament_players` WHERE tournament_id=? AND player_id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @param array<string,mixed> $settings @param array<string,mixed> $registration @return array<string,mixed> */
    private function formatResult(array $settings, array $registration, ?float $distance, bool $already): array
    {
        return [
            'tournament_id' => (int) $settings['id'],
            'player_id' => (int) $registration['player_id'],
            'status' => 'checked_in',
            'checked_in_at' => $registration['checked_in_at'] ?? null,
            'checkin_source' => $registration['checkin_source'] ?? null,
            'distance_meters' => $distance ?? ($registration['checkin_distance_meters'] !== null ? (float) $registration['checkin_distance_meters'] : null),
            'already_checked_in' => $already,
        ];
    }

    private function databaseNow(): DateTimeImmutable
    {
        $row = $this->connection->query('SELECT NOW() AS now_value')->fetch_assoc();
        return new DateTimeImmutable((string) ($row['now_value'] ?? 'now'));
    }

    private function distanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $earth = 6371000.0;
        $phi1 = deg2rad($lat1);
        $phi2 = deg2rad($lat2);
        $dPhi = deg2rad($lat2 - $lat1);
        $dLambda = deg2rad($lng2 - $lng1);
        $a = sin($dPhi / 2) ** 2 + cos($phi1) * cos($phi2) * sin($dLambda / 2) ** 2;
        return $earth * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }

    private function nullableFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') return null;
        if (!is_numeric($value)) throw new ValidationException('invalid_coordinate', 'Koordinat må være et tall.');
        return (float) $value;
    }

    private function nullableDateTime(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '') return null;
        $timestamp = strtotime((string) $value);
        if ($timestamp === false) throw new ValidationException('invalid_checkin_datetime', 'Ugyldig dato/tid for check-in.');
        return date('Y-m-d H:i:s', $timestamp);
    }

    private function nullablePositiveInt(mixed $value, int $min, int $max): ?int
    {
        if ($value === null || $value === '') return null;
        $int = (int) $value;
        if ($int < $min || $int > $max) throw new ValidationException('invalid_checkin_radius', 'Ugyldig radius for check-in.');
        return $int;
    }

    private function boolInt(mixed $value): int
    {
        if (is_bool($value)) return $value ? 1 : 0;
        return in_array(strtolower(trim((string) $value)), ['1','true','yes','on'], true) ? 1 : 0;
    }

    private function nullableBoolInt(mixed $value): ?int
    {
        if ($value === null || $value === '') return null;
        return $this->boolInt($value);
    }
}
