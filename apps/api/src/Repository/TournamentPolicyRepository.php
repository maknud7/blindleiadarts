<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;
use Throwable;

final class TournamentPolicyRepository
{
    public const REGISTRATION_LEAD_HOURS = 167; // 6 days + 23 hours
    public const CHECKIN_LEAD_HOURS = 2;
    private const OPEN_UNTIL_EXPLICIT_START = '2099-12-31 23:59:59';

    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
        if (!preg_match('/^[A-Za-z0-9_]+$/', $this->prefix)) {
            throw new \RuntimeException('Invalid database table prefix.');
        }
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function createTournament(int $clubId, array $payload): array
    {
        $club = $this->club($clubId);
        if ($club === null) {
            throw new ValidationException('club_not_found', 'Klubben ble ikke funnet.', 404);
        }

        $name = trim((string) ($payload['name'] ?? ''));
        if ($name === '') {
            throw new ValidationException('tournament_name_required', 'Turneringen må ha et navn.');
        }
        $startAt = $this->dateTime($payload['start_at'] ?? null, 'Planlagt start må settes.');
        $endAt = $this->nullableDateTime($payload['end_at'] ?? null);
        if ($endAt !== null && strtotime($endAt) <= strtotime($startAt)) {
            throw new ValidationException('invalid_tournament_end', 'Planlagt slutt må være etter planlagt start.');
        }

        // No implicit season assignment. Null means this tournament deliberately
        // stands outside a series/season.
        $seasonId = $this->nullableId($payload['season_id'] ?? null);
        if ($seasonId !== null && !$this->seasonBelongsToClub($seasonId, $clubId)) {
            throw new ValidationException('season_not_in_club', 'Valgt sesong tilhører ikke denne klubben.');
        }

        $slug = $this->uniqueTournamentSlug($this->slugify((string) ($payload['slug'] ?? $name)));
        $providerSystem = trim((string) ($payload['provider_system'] ?? 'local')) ?: 'local';
        $maxVisits = max(1, min(100, (int) ($payload['max_visits_per_leg'] ?? 50)));
        $maxPlayers = array_key_exists('max_players', $payload) ? $this->nullablePositiveInt($payload['max_players']) : null;
        [$registrationOpens, $checkinOpens] = $this->derivedOpens($startAt);

        $billingMode = (string) ($club['billing_mode'] ?? 'free');
        $billingAmount = $billingMode === 'stripe' ? max(0, (int) ($club['tournament_fee_ore'] ?? 0)) : 0;
        $billingStatus = $billingMode === 'stripe' && $billingAmount > 0 ? 'pending' : 'waived';
        $status = 'draft';
        $autoAssign = 0; // Explicit Start enables the tournament runtime.
        $checkinClose = self::OPEN_UNTIL_EXPLICIT_START;

        $sql = sprintf(
            'INSERT INTO `%1$stournaments`
             (club_id,season_id,name,slug,provider_system,status,max_visits_per_leg,start_at,end_at,
              registration_opens_at,registration_closes_at,max_players,
              checkin_opens_at,checkin_closes_at,auto_assign_enabled,
              billing_status,billing_amount_ore)
             VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param(
            'iissssissssisiisi',
            $clubId,
            $seasonId,
            $name,
            $slug,
            $providerSystem,
            $status,
            $maxVisits,
            $startAt,
            $endAt,
            $registrationOpens,
            $maxPlayers,
            $checkinOpens,
            $checkinClose,
            $autoAssign,
            $billingStatus,
            $billingAmount
        );
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();

        return $this->policy($id) ?? [];
    }

    /** @return array<string,mixed>|null */
    public function policy(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT t.id,t.club_id,t.season_id,t.name,t.slug,t.status,t.start_at,t.actual_started_at,t.end_at,
                    t.registration_opens_at,t.registration_closes_at,t.max_players,
                    t.checkin_opens_at,t.checkin_closes_at,t.checkin_method,t.checkin_code,
                    t.billing_status,t.billing_amount_ore,t.stripe_checkout_session_id,t.auto_assign_enabled,
                    c.name AS club_name,c.billing_mode AS club_billing_mode,c.tournament_fee_ore AS club_tournament_fee_ore,
                    c.stripe_customer_id,s.name AS season_name
             FROM `%1$stournaments` t
             INNER JOIN `%1$sclubs` c ON c.id=t.club_id
             LEFT JOIN `%1$sseasons` s ON s.id=t.season_id
             WHERE t.id=? LIMIT 1',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;

        $row['registration_rule'] = 'opens_167_hours_before_start_closes_on_start';
        $row['checkin_rule'] = 'opens_2_hours_before_start_closes_on_start';
        $row['registration_closes_on_start'] = true;
        $row['checkin_closes_on_start'] = true;
        // Never expose the internal sentinel as a meaningful product deadline.
        if ((string) ($row['checkin_closes_at'] ?? '') === self::OPEN_UNTIL_EXPLICIT_START) {
            $row['checkin_closes_at'] = null;
        }
        return $row;
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateRegistrationSettings(int $tournamentId, array $payload): array
    {
        $current = $this->policy($tournamentId);
        if ($current === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        if ($current['actual_started_at'] !== null || in_array((string) $current['status'], ['in_progress','completed','archived'], true)) {
            throw new ValidationException('registration_locked', 'Påmeldingen er låst fordi turneringen er startet.', 409);
        }
        $maxPlayers = array_key_exists('max_players', $payload)
            ? $this->nullablePositiveInt($payload['max_players'])
            : ($current['max_players'] !== null ? (int) $current['max_players'] : null);
        [$registrationOpens, $checkinOpens] = $this->derivedOpens((string) $current['start_at']);
        $checkinClose = self::OPEN_UNTIL_EXPLICIT_START;

        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments`
             SET registration_opens_at=?,registration_closes_at=NULL,max_players=?,
                 checkin_opens_at=?,checkin_closes_at=?
             WHERE id=?',
            $this->prefix
        ));
        $stmt->bind_param('sissi', $registrationOpens, $maxPlayers, $checkinOpens, $checkinClose, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->policy($tournamentId) ?? [];
    }

    /** @return array<string,mixed> */
    public function enforceFixedWindows(int $tournamentId): array
    {
        $current = $this->policy($tournamentId);
        if ($current === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        [$registrationOpens, $checkinOpens] = $this->derivedOpens((string) $current['start_at']);
        $startedAt = $current['actual_started_at'] !== null ? (string) $current['actual_started_at'] : null;
        $checkinClose = $startedAt ?? self::OPEN_UNTIL_EXPLICIT_START;
        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments`
             SET registration_opens_at=?,registration_closes_at=?,checkin_opens_at=?,checkin_closes_at=?
             WHERE id=?',
            $this->prefix
        ));
        $stmt->bind_param('ssssi', $registrationOpens, $startedAt, $checkinOpens, $checkinClose, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->policy($tournamentId) ?? [];
    }

    /** @return array<string,mixed> */
    public function startTournament(int $tournamentId): array
    {
        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare(sprintf(
                'SELECT t.id,t.status,t.actual_started_at,t.billing_status,t.billing_amount_ore,c.billing_mode
                 FROM `%1$stournaments` t INNER JOIN `%1$sclubs` c ON c.id=t.club_id
                 WHERE t.id=? LIMIT 1 FOR UPDATE',
                $this->prefix
            ));
            $stmt->bind_param('i', $tournamentId);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc() ?: null;
            $stmt->close();
            if ($row === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
            if (in_array((string) $row['status'], ['completed','archived'], true)) {
                throw new ValidationException('tournament_cannot_start', 'En avsluttet turnering kan ikke startes på nytt.', 409);
            }
            if ($row['actual_started_at'] !== null) {
                $this->connection->commit();
                return $this->policy($tournamentId) ?? [];
            }
            if ((string) $row['billing_mode'] === 'stripe'
                && (int) $row['billing_amount_ore'] > 0
                && (string) $row['billing_status'] !== 'paid') {
                throw new ValidationException('tournament_payment_required', 'Turneringen må være betalt før den kan startes.', 402);
            }

            $update = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournaments`
                 SET status="in_progress",actual_started_at=NOW(),registration_closes_at=NOW(),checkin_closes_at=NOW(),auto_assign_enabled=1
                 WHERE id=?',
                $this->prefix
            ));
            $update->bind_param('i', $tournamentId);
            $update->execute();
            $update->close();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
        return $this->policy($tournamentId) ?? [];
    }

    /** @return array<int,array<string,mixed>> */
    public function listClubsForSuperadmin(): array
    {
        $sql = sprintf(
            'SELECT c.id,c.name,c.slug,c.logo_url,c.billing_mode,c.tournament_fee_ore,c.stripe_customer_id,
                    COUNT(DISTINCT t.id) AS tournament_count,
                    COUNT(DISTINCT CASE WHEN t.billing_status="pending" THEN t.id END) AS unpaid_tournament_count
             FROM `%1$sclubs` c LEFT JOIN `%1$stournaments` t ON t.club_id=c.id
             GROUP BY c.id,c.name,c.slug,c.logo_url,c.billing_mode,c.tournament_fee_ore,c.stripe_customer_id
             ORDER BY c.name',
            $this->prefix
        );
        return $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updateClubBilling(int $clubId, array $payload): array
    {
        $club = $this->club($clubId);
        if ($club === null) throw new ValidationException('club_not_found', 'Klubben ble ikke funnet.', 404);
        $mode = strtolower(trim((string) ($payload['billing_mode'] ?? $club['billing_mode'] ?? 'free')));
        if (!in_array($mode, ['free','stripe'], true)) {
            throw new ValidationException('invalid_billing_mode', 'Betalingsmodell må være Gratis eller Stripe.');
        }
        $fee = array_key_exists('tournament_fee_ore', $payload)
            ? max(0, (int) $payload['tournament_fee_ore'])
            : max(0, (int) ($club['tournament_fee_ore'] ?? 0));
        if ($mode === 'free') $fee = 0;
        $customer = array_key_exists('stripe_customer_id', $payload)
            ? $this->nullableString($payload['stripe_customer_id'])
            : $this->nullableString($club['stripe_customer_id'] ?? null);

        $stmt = $this->connection->prepare(sprintf(
            'UPDATE `%1$sclubs` SET billing_mode=?,tournament_fee_ore=?,stripe_customer_id=? WHERE id=?',
            $this->prefix
        ));
        $stmt->bind_param('sisi', $mode, $fee, $customer, $clubId);
        $stmt->execute();
        $stmt->close();
        return $this->club($clubId) ?? [];
    }

    /** @return array<string,mixed>|null */
    private function club(int $clubId): ?array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT id,name,slug,logo_url,billing_mode,tournament_fee_ore,stripe_customer_id FROM `%1$sclubs` WHERE id=? LIMIT 1',
            $this->prefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    private function seasonBelongsToClub(int $seasonId, int $clubId): bool
    {
        $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$sseasons` WHERE id=? AND club_id=? LIMIT 1', $this->prefix));
        $stmt->bind_param('ii', $seasonId, $clubId);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_assoc() !== null;
        $stmt->close();
        return $exists;
    }

    /** @return array{0:string,1:string} */
    private function derivedOpens(string $startAt): array
    {
        $start = new DateTimeImmutable($startAt);
        return [
            $start->modify('-' . self::REGISTRATION_LEAD_HOURS . ' hours')->format('Y-m-d H:i:s'),
            $start->modify('-' . self::CHECKIN_LEAD_HOURS . ' hours')->format('Y-m-d H:i:s'),
        ];
    }

    private function dateTime(mixed $value, string $message): string
    {
        $value = trim((string) ($value ?? ''));
        if ($value === '' || strtotime($value) === false) throw new ValidationException('invalid_start_at', $message);
        return date('Y-m-d H:i:s', strtotime($value));
    }

    private function nullableDateTime(mixed $value): ?string
    {
        $value = trim((string) ($value ?? ''));
        if ($value === '') return null;
        if (strtotime($value) === false) throw new ValidationException('invalid_datetime', 'Ugyldig dato eller klokkeslett.');
        return date('Y-m-d H:i:s', strtotime($value));
    }

    private function nullablePositiveInt(mixed $value): ?int
    {
        if ($value === null || trim((string) $value) === '') return null;
        $number = (int) $value;
        if ($number < 2) throw new ValidationException('invalid_max_players', 'Maks spillere må være minst 2.');
        return $number;
    }

    private function nullableId(mixed $value): ?int
    {
        if ($value === null || trim((string) $value) === '') return null;
        $id = (int) $value;
        return $id > 0 ? $id : null;
    }

    private function nullableString(mixed $value): ?string
    {
        $value = trim((string) ($value ?? ''));
        return $value === '' ? null : $value;
    }

    private function slugify(string $value): string
    {
        $value = mb_strtolower(trim($value), 'UTF-8');
        $value = preg_replace('/[^a-z0-9]+/u', '-', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value) ?: $value) ?? '';
        return trim($value, '-') ?: 'turnering';
    }

    private function uniqueTournamentSlug(string $base): string
    {
        $candidate = $base;
        for ($suffix = 1; $suffix <= 999; $suffix++) {
            $stmt = $this->connection->prepare(sprintf('SELECT id FROM `%1$stournaments` WHERE slug=? LIMIT 1', $this->prefix));
            $stmt->bind_param('s', $candidate);
            $stmt->execute();
            $exists = $stmt->get_result()->fetch_assoc() !== null;
            $stmt->close();
            if (!$exists) return $candidate;
            $candidate = $base . '-' . ($suffix + 1);
        }
        throw new ValidationException('tournament_slug_unavailable', 'Kunne ikke lage en unik turneringsadresse.', 409);
    }
}
