<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;
use mysqli_sql_exception;

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
        $stmt = $this->connection->prepare(sprintf(
            'SELECT * FROM `%1$sclub_checkin_settings` WHERE club_id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();

        return array_merge([
            'club_id' => $clubId,
            'default_method' => 'admin_or_code',
            'venue_latitude' => null,
            'venue_longitude' => null,
            'onsite_radius_meters' => 150,
            'opens_minutes_before_start' => 60,
            'closes_minutes_after_start' => 10,
            'require_geolocation' => 1,
            'gps_fallback_enabled' => 1,
            'max_location_accuracy_meters' => 250,
        ], $row);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubSettings(int $clubId, array $payload, int $userId): array
    {
        $current = $this->getClubSettings($clubId);
        $method = $this->normalizeMethod($payload['default_method'] ?? $current['default_method']);
        $lat = $this->nullableFloat($payload['venue_latitude'] ?? $current['venue_latitude']);
        $lng = $this->nullableFloat($payload['venue_longitude'] ?? $current['venue_longitude']);

        if (($lat === null) xor ($lng === null)) {
            throw new ValidationException('checkin_coordinates_incomplete', 'Både breddegrad og lengdegrad må settes for GPS-fallback.');
        }
        if ($lat !== null && ($lat < -90 || $lat > 90)) {
            throw new ValidationException('invalid_venue_latitude', 'Ugyldig breddegrad.');
        }
        if ($lng !== null && ($lng < -180 || $lng > 180)) {
            throw new ValidationException('invalid_venue_longitude', 'Ugyldig lengdegrad.');
        }

        $radius = min(5000, max(20, (int) ($payload['onsite_radius_meters'] ?? $current['onsite_radius_meters'])));
        $opens = min(1440, max(0, (int) ($payload['opens_minutes_before_start'] ?? $current['opens_minutes_before_start'])));
        $closes = min(360, max(0, (int) ($payload['closes_minutes_after_start'] ?? $current['closes_minutes_after_start'])));
        $require = $this->boolInt($payload['require_geolocation'] ?? $current['require_geolocation']);
        $gpsFallback = $this->boolInt($payload['gps_fallback_enabled'] ?? $current['gps_fallback_enabled']);
        $accuracy = min(2000, max(20, (int) ($payload['max_location_accuracy_meters'] ?? $current['max_location_accuracy_meters'])));

        $sql = sprintf(
            'INSERT INTO `%1$sclub_checkin_settings`
             (club_id,default_method,venue_latitude,venue_longitude,onsite_radius_meters,opens_minutes_before_start,
              closes_minutes_after_start,require_geolocation,gps_fallback_enabled,max_location_accuracy_meters,updated_by_user_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE default_method=VALUES(default_method),venue_latitude=VALUES(venue_latitude),
              venue_longitude=VALUES(venue_longitude),onsite_radius_meters=VALUES(onsite_radius_meters),
              opens_minutes_before_start=VALUES(opens_minutes_before_start),closes_minutes_after_start=VALUES(closes_minutes_after_start),
              require_geolocation=VALUES(require_geolocation),gps_fallback_enabled=VALUES(gps_fallback_enabled),
              max_location_accuracy_meters=VALUES(max_location_accuracy_meters),updated_by_user_id=VALUES(updated_by_user_id)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isddiiiiiii', $clubId, $method, $lat, $lng, $radius, $opens, $closes, $require, $gpsFallback, $accuracy, $userId);
        $stmt->execute();
        $stmt->close();

        return $this->getClubSettings($clubId);
    }

    /** @return array<string,mixed>|null */
    public function getTournamentSettings(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT t.id,t.club_id,t.name,t.status,t.start_at,t.checkin_opens_at,t.checkin_closes_at,
                    t.checkin_method,t.checkin_code,t.checkin_require_onsite,t.checkin_gps_fallback_enabled,t.checkin_radius_meters
             FROM `%1$stournaments` t WHERE t.id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $tournament = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($tournament === null) {
            return null;
        }

        $club = $this->getClubSettings((int) $tournament['club_id']);
        return $this->withEffectiveSettings($tournament, $club);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed>|null */
    public function updateTournamentSettings(int $tournamentId, array $payload): ?array
    {
        $current = $this->getTournamentSettings($tournamentId);
        if ($current === null) {
            return null;
        }

        $opensAt = array_key_exists('checkin_opens_at', $payload)
            ? $this->nullableDateTime($payload['checkin_opens_at'])
            : ($current['checkin_opens_at'] ?? null);
        $closesAt = array_key_exists('checkin_closes_at', $payload)
            ? $this->nullableDateTime($payload['checkin_closes_at'])
            : ($current['checkin_closes_at'] ?? null);
        $method = array_key_exists('checkin_method', $payload)
            ? $this->nullableMethod($payload['checkin_method'])
            : $this->nullableMethod($current['checkin_method'] ?? null);
        $require = array_key_exists('checkin_require_onsite', $payload)
            ? $this->nullableBoolInt($payload['checkin_require_onsite'])
            : $this->nullableBoolInt($current['checkin_require_onsite'] ?? null);
        $gpsFallback = array_key_exists('checkin_gps_fallback_enabled', $payload)
            ? $this->nullableBoolInt($payload['checkin_gps_fallback_enabled'])
            : $this->nullableBoolInt($current['checkin_gps_fallback_enabled'] ?? null);
        $radius = array_key_exists('checkin_radius_meters', $payload)
            ? $this->nullablePositiveInt($payload['checkin_radius_meters'], 20, 5000)
            : ($current['checkin_radius_meters'] !== null ? (int) $current['checkin_radius_meters'] : null);

        if ($opensAt !== null && $closesAt !== null && strtotime($opensAt) >= strtotime($closesAt)) {
            throw new ValidationException('invalid_checkin_window', 'Check-in må stenge etter at den åpner.');
        }

        $code = array_key_exists('checkin_code', $payload)
            ? $this->normalizeCode($payload['checkin_code'])
            : $this->normalizeCode($current['checkin_code'] ?? null);
        $rotate = $this->boolInt($payload['rotate_checkin_code'] ?? false) === 1;
        $effectiveMethod = $method ?? $this->normalizeMethod($current['default_method'] ?? 'admin_or_code');
        if ($rotate || ($this->methodUsesCode($effectiveMethod) && $code === null)) {
            $code = $this->generateUniqueCode((int) $current['club_id'], $tournamentId);
        }
        if (!$this->methodUsesCode($effectiveMethod) && array_key_exists('checkin_method', $payload)) {
            $code = null;
        }

        $sql = sprintf(
            'UPDATE `%1$stournaments`
             SET checkin_opens_at=?,checkin_closes_at=?,checkin_method=?,checkin_code=?,
                 checkin_require_onsite=?,checkin_gps_fallback_enabled=?,checkin_radius_meters=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssssiiii', $opensAt, $closesAt, $method, $code, $require, $gpsFallback, $radius, $tournamentId);
        $stmt->execute();
        $stmt->close();

        return $this->getTournamentSettings($tournamentId);
    }

    /** @return array<string,mixed> */
    public function rotateTournamentCode(int $tournamentId): array
    {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }
        $code = $this->generateUniqueCode((int) $settings['club_id'], $tournamentId);
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments` SET checkin_code=? WHERE id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('si', $code, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->getTournamentSettings($tournamentId) ?? [];
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
        bool $adminOverride = false,
        ?string $code = null,
        bool $force = false
    ): array {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }

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

        if (!$force) {
            $this->assertWindowOpen($settings);
        }

        $source = 'legacy';
        $distance = null;

        if ($adminOverride) {
            $source = 'admin_override';
        } else {
            $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');
            if ($method === 'admin_only') {
                throw new ValidationException('checkin_admin_required', 'Denne turneringen checkes inn av turneringsleder.', 409);
            }

            $normalizedCode = $this->normalizeCode($code);
            $expectedCode = $this->normalizeCode($settings['checkin_code'] ?? null);
            $codeAccepted = false;

            if ($this->methodUsesCode($method) && $normalizedCode !== null && $expectedCode !== null) {
                $codeAccepted = hash_equals($expectedCode, $normalizedCode);
                if ($codeAccepted) {
                    $source = 'player_code';
                }
            }

            if (!$codeAccepted) {
                $gpsAllowed = $method === 'gps' || (int) ($settings['effective_gps_fallback_enabled'] ?? 0) === 1;
                if ($gpsAllowed && $latitude !== null && $longitude !== null && $accuracyMeters !== null) {
                    $distance = $this->validateGps($settings, $latitude, $longitude, $accuracyMeters);
                    $source = 'player_geolocation';
                } elseif ($this->methodUsesCode($method)) {
                    if ($normalizedCode !== null) {
                        throw new ValidationException('checkin_code_invalid', 'Check-in-koden stemmer ikke. Se koden på live-skjermen eller kontakt turneringsleder.', 409);
                    }
                    if ($gpsAllowed) {
                        throw new ValidationException('checkin_code_or_gps_required', 'Tast inn koden fra live-skjermen. Hvis kode ikke kan brukes, kan GPS-fallback prøves.', 422);
                    }
                    throw new ValidationException('checkin_code_required', 'Tast inn check-in-koden som vises i lokalet.', 422);
                } else {
                    throw new ValidationException('checkin_location_required', 'GPS-posisjon må deles for denne turneringen.', 422);
                }
            }
        }

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
        if ($settings === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }
        $registration = $this->registration($tournamentId, $playerId);
        $windowState = $this->windowState($settings);
        $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');

        return [
            'tournament_id' => $tournamentId,
            'registration_status' => $registration['status'] ?? null,
            'window_state' => $windowState,
            'opens_at' => $settings['effective_checkin_opens_at'],
            'closes_at' => $settings['effective_checkin_closes_at'],
            'method' => $method,
            'code_allowed' => $this->methodUsesCode($method),
            'admin_checkin_allowed' => in_array($method, ['admin_or_code', 'admin_only', 'code', 'gps'], true),
            'gps_fallback_enabled' => (int) ($settings['effective_gps_fallback_enabled'] ?? 0) === 1,
            'require_onsite_for_gps' => (int) ($settings['effective_require_onsite'] ?? 1) === 1,
            'radius_meters' => (int) ($settings['effective_radius_meters'] ?? 150),
            'venue_configured' => $settings['venue_latitude'] !== null && $settings['venue_longitude'] !== null,
            'checked_in_at' => $registration['checked_in_at'] ?? null,
            'checkin_source' => $registration['checkin_source'] ?? null,
        ];
    }

    /** @return array<string,mixed>|null */
    public function publicDisplayForClub(int $clubId): ?array
    {
        $sql = sprintf(
            'SELECT id FROM `%1$stournaments`
             WHERE club_id=? AND status IN ("draft","ready","in_progress") AND start_at IS NOT NULL
               AND start_at BETWEEN DATE_SUB(NOW(), INTERVAL 8 HOUR) AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
             ORDER BY FIELD(status,"in_progress","ready","draft"), ABS(TIMESTAMPDIFF(SECOND,NOW(),start_at)), id ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $result = $stmt->get_result();
        $ids = [];
        while ($row = $result->fetch_assoc()) {
            $ids[] = (int) $row['id'];
        }
        $stmt->close();

        foreach ($ids as $tournamentId) {
            $settings = $this->getTournamentSettings($tournamentId);
            if ($settings === null || $this->windowState($settings) !== 'open') {
                continue;
            }
            $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');
            if (!$this->methodUsesCode($method)) {
                continue;
            }
            if ($this->normalizeCode($settings['checkin_code'] ?? null) === null) {
                $settings = $this->rotateTournamentCode($tournamentId);
            }
            return [
                'tournament_id' => $tournamentId,
                'tournament_name' => $settings['name'],
                'code' => $settings['checkin_code'],
                'opens_at' => $settings['effective_checkin_opens_at'],
                'closes_at' => $settings['effective_checkin_closes_at'],
                'method' => $method,
            ];
        }

        return null;
    }

    /** @param array<string,mixed> $settings */
    private function assertWindowOpen(array $settings): void
    {
        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        $closes = new DateTimeImmutable((string) $settings['effective_checkin_closes_at']);
        if ($now < $opens) {
            throw new ValidationException('checkin_not_open', 'Check-in åpner ' . $opens->format('d.m.Y H:i') . '.', 409);
        }
        if ($now > $closes) {
            throw new ValidationException('checkin_closed', 'Check-in stengte ' . $closes->format('d.m.Y H:i') . '. Kontakt arrangør.', 409);
        }
    }

    /** @param array<string,mixed> $settings */
    private function windowState(array $settings): string
    {
        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        $closes = new DateTimeImmutable((string) $settings['effective_checkin_closes_at']);
        return $now < $opens ? 'not_open' : ($now > $closes ? 'closed' : 'open');
    }

    /** @param array<string,mixed> $settings */
    private function validateGps(array $settings, float $latitude, float $longitude, float $accuracyMeters): ?float
    {
        if ($latitude < -90 || $latitude > 90 || $longitude < -180 || $longitude > 180) {
            throw new ValidationException('checkin_location_invalid', 'Telefonen returnerte en ugyldig posisjon.', 422);
        }
        $maxAccuracy = (float) ($settings['max_location_accuracy_meters'] ?? 250);
        if ($accuracyMeters <= 0 || $accuracyMeters > $maxAccuracy) {
            throw new ValidationException('checkin_location_too_inaccurate', 'Posisjonen er for unøyaktig. Prøv igjen eller bruk koden i lokalet.', 409);
        }

        if ((int) ($settings['effective_require_onsite'] ?? 1) !== 1) {
            return null;
        }

        $venueLat = $this->nullableFloat($settings['venue_latitude'] ?? null);
        $venueLng = $this->nullableFloat($settings['venue_longitude'] ?? null);
        if ($venueLat === null || $venueLng === null) {
            throw new ValidationException('checkin_venue_not_configured', 'GPS-fallback er ikke konfigurert for lokalet. Bruk koden eller kontakt arrangør.', 503);
        }

        $distance = $this->distanceMeters($venueLat, $venueLng, $latitude, $longitude);
        $radius = (float) ($settings['effective_radius_meters'] ?? 150);
        $gpsMargin = min(30.0, max(0.0, $accuracyMeters));
        if ($distance > $radius + $gpsMargin) {
            throw new ValidationException(
                'checkin_not_onsite',
                sprintf('Du ser ut til å være ca. %d meter fra arenaen.', (int) round($distance)),
                409
            );
        }
        return $distance;
    }

    /** @param array<string,mixed> $tournament @param array<string,mixed> $club @return array<string,mixed> */
    private function withEffectiveSettings(array $tournament, array $club): array
    {
        $startAt = trim((string) ($tournament['start_at'] ?? ''));
        if ($startAt === '') {
            throw new ValidationException('checkin_start_time_required', 'Turneringen må ha starttid før check-in kan konfigureres.', 422);
        }

        $start = new DateTimeImmutable($startAt);
        $opens = $tournament['checkin_opens_at']
            ?: $start->modify('-' . (int) $club['opens_minutes_before_start'] . ' minutes')->format('Y-m-d H:i:s');
        $closes = $tournament['checkin_closes_at']
            ?: $start->modify('+' . (int) $club['closes_minutes_after_start'] . ' minutes')->format('Y-m-d H:i:s');
        $method = $tournament['checkin_method'] ?: $this->normalizeMethod($club['default_method'] ?? 'admin_or_code');
        $require = $tournament['checkin_require_onsite'] === null
            ? (int) $club['require_geolocation']
            : (int) $tournament['checkin_require_onsite'];
        $gpsFallback = $tournament['checkin_gps_fallback_enabled'] === null
            ? (int) $club['gps_fallback_enabled']
            : (int) $tournament['checkin_gps_fallback_enabled'];
        $radius = $tournament['checkin_radius_meters'] === null
            ? (int) $club['onsite_radius_meters']
            : (int) $tournament['checkin_radius_meters'];

        return array_merge($tournament, $club, [
            'effective_checkin_opens_at' => $opens,
            'effective_checkin_closes_at' => $closes,
            'effective_method' => $method,
            'effective_require_onsite' => $require,
            'effective_gps_fallback_enabled' => $gpsFallback,
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

    private function normalizeMethod(mixed $value): string
    {
        $method = strtolower(trim((string) $value));
        return in_array($method, ['admin_or_code', 'admin_only', 'code', 'gps'], true) ? $method : 'admin_or_code';
    }

    private function nullableMethod(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '' || strtolower(trim((string) $value)) === 'inherit') {
            return null;
        }
        $method = strtolower(trim((string) $value));
        if (!in_array($method, ['admin_or_code', 'admin_only', 'code', 'gps'], true)) {
            throw new ValidationException('invalid_checkin_method', 'Ugyldig check-in-metode.');
        }
        return $method;
    }

    private function methodUsesCode(string $method): bool
    {
        return in_array($method, ['admin_or_code', 'code'], true);
    }

    private function normalizeCode(mixed $value): ?string
    {
        $code = strtoupper(trim((string) ($value ?? '')));
        $code = preg_replace('/[^A-Z0-9]/', '', $code) ?? '';
        if ($code === '') {
            return null;
        }
        if (strlen($code) < 4 || strlen($code) > 12) {
            throw new ValidationException('invalid_checkin_code', 'Check-in-koden må være 4–12 tegn.');
        }
        return $code;
    }

    private function generateUniqueCode(int $clubId, int $excludeTournamentId): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for ($attempt = 0; $attempt < 30; $attempt++) {
            $code = '';
            for ($i = 0; $i < 6; $i++) {
                $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $stmt = $this->connection->prepare(sprintf(
                'SELECT id FROM `%1$stournaments` WHERE club_id=? AND checkin_code=? AND id<>? LIMIT 1',
                $this->tablePrefix
            ));
            $stmt->bind_param('isi', $clubId, $code, $excludeTournamentId);
            $stmt->execute();
            $exists = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            if (!$exists) {
                return $code;
            }
        }
        throw new ValidationException('checkin_code_generation_failed', 'Kunne ikke lage en unik check-in-kode.', 500);
    }

    private function nullableDateTime(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '') {
            return null;
        }
        $timestamp = strtotime((string) $value);
        if ($timestamp === false) {
            throw new ValidationException('invalid_checkin_datetime', 'Ugyldig dato/tid for check-in.');
        }
        return date('Y-m-d H:i:s', $timestamp);
    }

    private function nullableFloat(mixed $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_numeric($value)) {
            throw new ValidationException('invalid_location', 'Posisjonsdata må være numeriske.');
        }
        return (float) $value;
    }

    private function nullablePositiveInt(mixed $value, int $min, int $max): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_numeric($value)) {
            throw new ValidationException('invalid_checkin_number', 'Check-in-verdien må være et tall.');
        }
        return min($max, max($min, (int) $value));
    }

    private function boolInt(mixed $value): int
    {
        if (is_bool($value)) return $value ? 1 : 0;
        if (is_numeric($value)) return (int) $value === 1 ? 1 : 0;
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
    }

    private function nullableBoolInt(mixed $value): ?int
    {
        if ($value === null || $value === '' || strtolower(trim((string) $value)) === 'inherit') {
            return null;
        }
        return $this->boolInt($value);
    }

    private function databaseNow(): DateTimeImmutable
    {
        $result = $this->connection->query('SELECT NOW(3) AS now_value');
        $row = $result->fetch_assoc() ?: [];
        return new DateTimeImmutable((string) ($row['now_value'] ?? 'now'));
    }

    private function distanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $earth = 6371000.0;
        $phi1 = deg2rad($lat1);
        $phi2 = deg2rad($lat2);
        $deltaPhi = deg2rad($lat2 - $lat1);
        $deltaLambda = deg2rad($lng2 - $lng1);
        $a = sin($deltaPhi / 2) ** 2 + cos($phi1) * cos($phi2) * sin($deltaLambda / 2) ** 2;
        return $earth * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }
}
