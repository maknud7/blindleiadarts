<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
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
        $stmt = $this->connection->prepare(sprintf(
            'SELECT club_id,default_method,opens_minutes_before_start,closes_minutes_after_start,updated_by_user_id,created_at,updated_at
             FROM `%1$sclub_checkin_settings` WHERE club_id=? LIMIT 1',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: [];
        $stmt->close();

        return array_merge([
            'club_id' => $clubId,
            'default_method' => 'admin_or_code',
            'opens_minutes_before_start' => 60,
            // Kept for backwards compatibility. Tournament check-in no longer
            // closes from this value; it closes when attendance is finalized.
            'closes_minutes_after_start' => 10,
        ], $row);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubSettings(int $clubId, array $payload, int $userId): array
    {
        $current = $this->getClubSettings($clubId);
        $method = $this->normalizeMethod($payload['default_method'] ?? $current['default_method']);
        $opens = min(1440, max(0, (int) ($payload['opens_minutes_before_start'] ?? $current['opens_minutes_before_start'])));
        $closes = min(360, max(0, (int) ($payload['closes_minutes_after_start'] ?? $current['closes_minutes_after_start'])));

        $sql = sprintf(
            'INSERT INTO `%1$sclub_checkin_settings`
             (club_id,default_method,opens_minutes_before_start,closes_minutes_after_start,updated_by_user_id)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE default_method=VALUES(default_method),
              opens_minutes_before_start=VALUES(opens_minutes_before_start),
              closes_minutes_after_start=VALUES(closes_minutes_after_start),
              updated_by_user_id=VALUES(updated_by_user_id)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isiii', $clubId, $method, $opens, $closes, $userId);
        $stmt->execute();
        $stmt->close();

        return $this->getClubSettings($clubId);
    }

    /** @return array<string,mixed>|null */
    public function getTournamentSettings(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT t.id,t.club_id,t.name,t.status,t.start_at,t.checkin_opens_at,t.checkin_closes_at,
                    t.checkin_method,t.checkin_code
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
        if ((string) ($current['status'] ?? '') !== 'draft') {
            throw new ValidationException('checkin_closed', 'Innsjekken er avsluttet.', 409);
        }

        $opensAt = array_key_exists('checkin_opens_at', $payload)
            ? $this->nullableDateTime($payload['checkin_opens_at'])
            : ($current['checkin_opens_at'] ?? null);
        // Closing is a workflow transition, not a configurable clock time.
        $closesAt = $current['checkin_closes_at'] ?? null;
        $method = array_key_exists('checkin_method', $payload)
            ? $this->nullableMethod($payload['checkin_method'])
            : $this->nullableMethod($current['checkin_method'] ?? null);

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
             SET checkin_opens_at=?,checkin_closes_at=?,checkin_method=?,checkin_code=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssssi', $opensAt, $closesAt, $method, $code, $tournamentId);
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
        if ((string) ($settings['status'] ?? '') !== 'draft') {
            throw new ValidationException('checkin_closed', 'Innsjekken er avsluttet.', 409);
        }
        $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');
        if (!$this->methodUsesCode($method)) {
            throw new ValidationException('checkin_code_not_enabled', 'Denne turneringen bruker ikke innsjekk-kode.', 409);
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

    /** @return array<string,mixed> */
    public function checkInPlayer(
        int $tournamentId,
        int $playerId,
        bool $adminOverride = false,
        ?string $code = null,
        bool $force = false
    ): array {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }
        if ((string) ($settings['status'] ?? '') !== 'draft') {
            throw new ValidationException('checkin_closed', 'Innsjekken er avsluttet.', 409);
        }

        $registration = $this->registration($tournamentId, $playerId);
        if ($registration === null) {
            throw new ValidationException('registration_required_before_check_in', 'Du må være påmeldt før du kan sjekke inn.', 422);
        }
        $status = (string) $registration['status'];
        if ($status === 'checked_in') {
            return $this->formatResult($settings, $registration, true);
        }
        if ($status === 'waitlisted') {
            throw new ValidationException('registration_waitlisted', 'Du står på venteliste og kan ikke sjekke inn før du har fått plass.', 422);
        }
        if ($status !== 'registered') {
            throw new ValidationException('registration_not_checkin_eligible', 'Denne påmeldingen kan ikke sjekkes inn.', 422);
        }

        if (!$force) {
            $this->assertWindowOpen($settings);
        }

        if ($adminOverride) {
            $source = 'admin_override';
        } else {
            $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');
            if ($method === 'admin_only') {
                throw new ValidationException('checkin_admin_required', 'Denne turneringen sjekkes inn av turneringsleder.', 409);
            }

            $normalizedCode = $this->normalizeCode($code);
            $expectedCode = $this->normalizeCode($settings['checkin_code'] ?? null);
            if ($normalizedCode === null) {
                throw new ValidationException('checkin_code_required', 'Tast inn innsjekk-koden som vises i lokalet.', 422);
            }
            if ($expectedCode === null || !hash_equals($expectedCode, $normalizedCode)) {
                throw new ValidationException('checkin_code_invalid', 'Innsjekk-koden stemmer ikke. Se koden på Live-skjermen eller kontakt turneringsleder.', 409);
            }
            $source = 'player_code';
        }

        $sql = sprintf(
            'UPDATE `%1$stournament_players`
             SET status="checked_in",checked_in_at=NOW(3),checkin_source=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $registrationId = (int) $registration['id'];
        $stmt->bind_param('si', $source, $registrationId);
        $stmt->execute();
        $stmt->close();

        $fresh = $this->registration($tournamentId, $playerId) ?? $registration;
        return $this->formatResult($settings, $fresh, false);
    }

    /** @return array<string,mixed> */
    public function statusForPlayer(int $tournamentId, int $playerId): array
    {
        $settings = $this->getTournamentSettings($tournamentId);
        if ($settings === null) {
            throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        }
        $registration = $this->registration($tournamentId, $playerId);
        $method = $this->normalizeMethod($settings['effective_method'] ?? 'admin_or_code');

        return [
            'tournament_id' => $tournamentId,
            'registration_status' => $registration['status'] ?? null,
            'window_state' => $this->windowState($settings),
            'opens_at' => $settings['effective_checkin_opens_at'],
            'closes_at' => $settings['effective_checkin_closes_at'],
            'method' => $method,
            'code_allowed' => $this->methodUsesCode($method),
            'admin_checkin_allowed' => (string) ($settings['status'] ?? '') === 'draft',
            'checked_in_at' => $registration['checked_in_at'] ?? null,
            'checkin_source' => $registration['checkin_source'] ?? null,
        ];
    }

    /** @return array<string,mixed>|null */
    public function publicDisplayForClub(int $clubId): ?array
    {
        $sql = sprintf(
            'SELECT id FROM `%1$stournaments`
             WHERE club_id=? AND status="draft" AND start_at IS NOT NULL
               AND start_at BETWEEN DATE_SUB(NOW(), INTERVAL 8 HOUR) AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
             ORDER BY ABS(TIMESTAMPDIFF(SECOND,NOW(),start_at)), id ASC',
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

            $participants = $this->publicParticipants($tournamentId);
            $checkedIn = 0;
            $registered = 0;
            $waitlisted = 0;
            foreach ($participants as $participant) {
                $status = (string) ($participant['status'] ?? '');
                if ($status === 'checked_in') {
                    $checkedIn++;
                } elseif ($status === 'registered') {
                    $registered++;
                } elseif ($status === 'waitlisted') {
                    $waitlisted++;
                }
            }

            return [
                'tournament_id' => $tournamentId,
                'tournament_name' => $settings['name'],
                'start_at' => $settings['start_at'],
                'code' => $settings['checkin_code'],
                'opens_at' => $settings['effective_checkin_opens_at'],
                'closes_at' => null,
                'method' => $method,
                'participants' => $participants,
                'participant_count' => $checkedIn + $registered,
                'checked_in_count' => $checkedIn,
                'registered_count' => $registered,
                'waitlisted_count' => $waitlisted,
            ];
        }

        return null;
    }

    /** @return array<int,array<string,mixed>> */
    private function publicParticipants(int $tournamentId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT p.id AS player_id,p.display_name,tp.status,tp.checked_in_at
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             WHERE tp.tournament_id=? AND tp.status IN ("checked_in","registered","waitlisted")
             ORDER BY FIELD(tp.status,"checked_in","registered","waitlisted"), p.display_name ASC',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $result = $stmt->get_result();
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = [
                'player_id' => (int) $row['player_id'],
                'display_name' => (string) $row['display_name'],
                'status' => (string) $row['status'],
                'checked_in_at' => $row['checked_in_at'] ?? null,
            ];
        }
        $stmt->close();
        return $rows;
    }

    /** @param array<string,mixed> $settings */
    private function assertWindowOpen(array $settings): void
    {
        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        if ($now < $opens) {
            throw new ValidationException('checkin_not_open', 'Innsjekk åpner ' . $opens->format('d.m.Y H:i') . '.', 409);
        }
    }

    /** @param array<string,mixed> $settings */
    private function windowState(array $settings): string
    {
        if ((string) ($settings['status'] ?? '') !== 'draft') {
            return 'closed';
        }
        $now = $this->databaseNow();
        $opens = new DateTimeImmutable((string) $settings['effective_checkin_opens_at']);
        return $now < $opens ? 'not_open' : 'open';
    }

    /** @param array<string,mixed> $tournament @param array<string,mixed> $club @return array<string,mixed> */
    private function withEffectiveSettings(array $tournament, array $club): array
    {
        $startAt = trim((string) ($tournament['start_at'] ?? ''));
        if ($startAt === '') {
            throw new ValidationException('checkin_start_time_required', 'Turneringen må ha starttid før innsjekk kan konfigureres.', 422);
        }

        $start = new DateTimeImmutable($startAt);
        $opens = $tournament['checkin_opens_at']
            ?: $start->modify('-' . (int) $club['opens_minutes_before_start'] . ' minutes')->format('Y-m-d H:i:s');
        $closes = $tournament['checkin_closes_at'] ?: null;
        $method = $tournament['checkin_method'] ?: $this->normalizeMethod($club['default_method'] ?? 'admin_or_code');

        return array_merge($tournament, $club, [
            'effective_checkin_opens_at' => $opens,
            'effective_checkin_closes_at' => $closes,
            'effective_method' => $method,
        ]);
    }

    /** @return array<string,mixed>|null */
    private function registration(int $tournamentId, int $playerId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,tournament_id,player_id,status,checked_in_at,checkin_source
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
    private function formatResult(array $settings, array $registration, bool $already): array
    {
        return [
            'tournament_id' => (int) $settings['id'],
            'player_id' => (int) $registration['player_id'],
            'status' => 'checked_in',
            'checked_in_at' => $registration['checked_in_at'] ?? null,
            'checkin_source' => $registration['checkin_source'] ?? null,
            'already_checked_in' => $already,
        ];
    }

    private function normalizeMethod(mixed $value): string
    {
        $method = strtolower(trim((string) $value));
        return in_array($method, ['admin_or_code', 'admin_only', 'code'], true) ? $method : 'admin_or_code';
    }

    private function nullableMethod(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '' || strtolower(trim((string) $value)) === 'inherit') {
            return null;
        }
        $method = strtolower(trim((string) $value));
        if (!in_array($method, ['admin_or_code', 'admin_only', 'code'], true)) {
            throw new ValidationException('invalid_checkin_method', 'Ugyldig metode for innsjekk.');
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
        if (strlen($code) < 3 || strlen($code) > 12) {
            throw new ValidationException('invalid_checkin_code', 'Innsjekk-koden må være 3–12 tegn.');
        }
        return $code;
    }

    private function generateUniqueCode(int $clubId, int $excludeTournamentId): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        for ($attempt = 0; $attempt < 30; $attempt++) {
            $code = '';
            for ($i = 0; $i < 3; $i++) {
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
        throw new ValidationException('checkin_code_generation_failed', 'Kunne ikke lage en unik innsjekk-kode.', 500);
    }

    private function nullableDateTime(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '') {
            return null;
        }
        $timestamp = strtotime((string) $value);
        if ($timestamp === false) {
            throw new ValidationException('invalid_checkin_datetime', 'Ugyldig dato eller tidspunkt for innsjekk.');
        }
        return date('Y-m-d H:i:s', $timestamp);
    }

    private function boolInt(mixed $value): int
    {
        if (is_bool($value)) return $value ? 1 : 0;
        if (is_numeric($value)) return (int) $value === 1 ? 1 : 0;
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
    }

    private function databaseNow(): DateTimeImmutable
    {
        $result = $this->connection->query('SELECT NOW(3) AS now_value');
        $row = $result->fetch_assoc() ?: [];
        return new DateTimeImmutable((string) ($row['now_value'] ?? 'now'));
    }
}
