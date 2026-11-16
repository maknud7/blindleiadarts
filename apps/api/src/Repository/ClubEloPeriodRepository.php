<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use DateTimeZone;
use mysqli;

/**
 * Club-level rating periods do not share the competition season identity.
 * Historical periods are immutable in time; rollover closes one and creates
 * its next-day successor in a single transaction.
 */
final class ClubEloPeriodRepository
{
    private mysqli $db;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->db = $database->connection();
        $this->prefix = $database->tablePrefix();
    }

    /** @return list<array<string,mixed>> */
    public function listForClub(int $clubId): array
    {
        $stmt = $this->db->prepare(sprintf(
            'SELECT id,club_id,name,starts_on,ends_on,created_at,updated_at
             FROM `%1$sclub_elo_periods` WHERE club_id=?
             ORDER BY starts_on DESC,id DESC', $this->prefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map([$this, 'formatPeriod'], $rows);
    }

    /** @return array<string,mixed>|null */
    public function find(int $periodId): ?array
    {
        $stmt = $this->db->prepare(sprintf(
            'SELECT id,club_id,name,starts_on,ends_on,created_at,updated_at
             FROM `%1$sclub_elo_periods` WHERE id=? LIMIT 1', $this->prefix
        ));
        $stmt->bind_param('i', $periodId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row === null ? null : $this->formatPeriod($row);
    }

    /** @return array<string,mixed>|null */
    public function current(int $clubId): ?array
    {
        $today = $this->today();
        foreach ($this->listForClub($clubId) as $row) {
            if ($row['starts_on'] <= $today && ($row['ends_on'] === null || $row['ends_on'] >= $today)) {
                return $row;
            }
        }
        return null;
    }

    /** @return array<string,mixed> */
    public function createFirst(int $clubId, array $body): array
    {
        $name = $this->name($body['name'] ?? 'Klubbens ELO');
        $starts = $this->date($body['starts_on'] ?? $this->today());
        if ($starts > $this->today()) {
            throw new ValidationException('elo_period_future_start',
                'Første ELO-periode må starte senest i dag, så klubben alltid har en aktiv rating.', 422);
        }
        $this->lockClub($clubId);
        try {
            if ($this->listForClub($clubId) !== []) {
                throw new ValidationException('elo_period_exists',
                    'Klubben har allerede en ELO-ordning. Bruk Ny ELO-periode.', 409);
            }
            $stmt = $this->db->prepare(sprintf(
                'INSERT INTO `%1$sclub_elo_periods` (club_id,name,starts_on,ends_on,open_slot)
                 VALUES (?,?,?,NULL,1)', $this->prefix
            ));
            $stmt->bind_param('iss', $clubId, $name, $starts);
            $stmt->execute();
            $id = (int) $stmt->insert_id;
            $stmt->close();
            $this->db->commit();
            return $this->find($id) ?? [];
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /** @return array{previous:array<string,mixed>,next:array<string,mixed>} */
    public function rollover(int $clubId, array $body): array
    {
        $ends = $this->date($body['ends_on'] ?? null);
        if ($ends < $this->today()) {
            throw new ValidationException('elo_period_historical_lock',
                'ELO kan ikke avsluttes med tilbakevirkende dato. Tidligere ratinger skal være uendret.', 409);
        }
        $newStarts = (new DateTimeImmutable($ends))->modify('+1 day')->format('Y-m-d');
        $name = $this->name($body['name'] ?? 'Ny ELO-periode');

        $this->lockClub($clubId);
        try {
            $items = $this->listForClub($clubId);
            $open = array_values(array_filter($items, static fn (array $p): bool => $p['ends_on'] === null));
            if (count($open) !== 1) {
                throw new ValidationException('elo_period_not_open',
                    'Klubben må ha én åpen ELO-periode før en ny kan planlegges.', 409);
            }
            $old = $open[0];
            if ($ends < $old['starts_on']) {
                throw new ValidationException('elo_period_invalid_dates',
                    'Sluttdato kan ikke komme før ELO-perioden startet.', 422);
            }
            foreach ($items as $p) {
                if ($p['id'] === $old['id']) continue;
                // Existing periods must not overlap either the old final day
                // or the new open-ended window.
                if ($p['ends_on'] === null || $p['ends_on'] >= $newStarts) {
                    throw new ValidationException('elo_period_overlap',
                        'En annen ELO-periode overlapper den nye perioden.', 409);
                }
            }
            $oldId = (int) $old['id'];
            $update = $this->db->prepare(sprintf(
                'UPDATE `%1$sclub_elo_periods`
                 SET ends_on=?,open_slot=NULL WHERE id=? AND club_id=? AND ends_on IS NULL', $this->prefix
            ));
            $update->bind_param('sii', $ends, $oldId, $clubId);
            $update->execute();
            if ($update->affected_rows !== 1) {
                throw new ValidationException('elo_period_changed',
                    'ELO-perioden er endret. Oppdater og prøv igjen.', 409);
            }
            $update->close();
            $insert = $this->db->prepare(sprintf(
                'INSERT INTO `%1$sclub_elo_periods` (club_id,name,starts_on,ends_on,open_slot)
                 VALUES (?,?,?,NULL,1)', $this->prefix
            ));
            $insert->bind_param('iss', $clubId, $name, $newStarts);
            $insert->execute();
            $id = (int) $insert->insert_id;
            $insert->close();
            $this->db->commit();
            return ['previous' => $this->find($oldId) ?? [], 'next' => $this->find($id) ?? []];
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /** @return array<string,mixed> */
    public function rename(int $periodId, mixed $name): array
    {
        if ($this->find($periodId) === null) {
            throw new ValidationException('elo_period_not_found', 'ELO-perioden finnes ikke.', 404);
        }
        $label = $this->name($name);
        $stmt = $this->db->prepare(sprintf(
            'UPDATE `%1$sclub_elo_periods` SET name=? WHERE id=?', $this->prefix
        ));
        $stmt->bind_param('si', $label, $periodId);
        $stmt->execute();
        $stmt->close();
        return $this->find($periodId) ?? [];
    }

    private function lockClub(int $clubId): void
    {
        $this->db->begin_transaction();
        $stmt = $this->db->prepare(sprintf(
            'SELECT id FROM `%1$sclubs` WHERE id=? FOR UPDATE', $this->prefix
        ));
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ($row === null) {
            $this->db->rollback();
            throw new ValidationException('club_not_found', 'Klubben finnes ikke.', 404);
        }
    }

    private function today(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('Europe/Oslo')))->format('Y-m-d');
    }

    private function formatPeriod(array $row): array
    {
        $row['id'] = (int) $row['id'];
        $row['club_id'] = (int) $row['club_id'];
        $today = $this->today();
        $row['status'] = $row['starts_on'] > $today ? 'scheduled'
            : (($row['ends_on'] !== null && $row['ends_on'] < $today) ? 'completed' : 'active');
        $row['is_active'] = $row['status'] === 'active';
        return $row;
    }

    private function name(mixed $value): string
    {
        $name = trim((string) $value);
        if ($name === '' || mb_strlen($name) > 150) {
            throw new ValidationException('elo_period_invalid_name',
                'ELO-perioden må ha et navn på maks 150 tegn.', 422);
        }
        return $name;
    }

    private function date(mixed $value): string
    {
        $raw = trim((string) ($value ?? ''));
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $raw);
        if (!$date || $date->format('Y-m-d') !== $raw) {
            throw new ValidationException('elo_period_invalid_date',
                'Dato må være på formatet ÅÅÅÅ-MM-DD.', 422);
        }
        return $raw;
    }
}
