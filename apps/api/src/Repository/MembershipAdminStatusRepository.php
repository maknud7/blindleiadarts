<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use DateTimeInterface;
use InvalidArgumentException;
use mysqli;
use RuntimeException;

/**
 * Canonical member-status evaluator for the Darts admin surface.
 *
 * The rules intentionally mirror blindleia-admin/includes/kontingentlogikk.php
 * and includes/medlemsarkiv.php: payment-pattern classification, three closed
 * months before automatic archive, current-month reactivation, two-paid-month
 * forgiveness of old gaps, manual overrides and Stripe auto-debit handling.
 */
final class MembershipAdminStatusRepository
{
    private mysqli $connection;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
    }

    /** @return array<string,mixed> */
    public function forMember(int $memberId): array
    {
        if ($memberId <= 0) {
            throw new InvalidArgumentException('Ugyldig medlem.');
        }

        $statement = $this->connection->prepare(
            'SELECT id, medlemsnummer, navn, innmeldingsdato, rolle,
                    betalingsstatus_override, kontingent_start, kontingent_slutt,
                    maanedsbelop, oppfolging_notat
             FROM `medlemmer`
             WHERE id=? LIMIT 1'
        );
        $statement->bind_param('i', $memberId);
        $statement->execute();
        $member = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($member === null) {
            throw new InvalidArgumentException('Medlemmet finnes ikke.');
        }

        $memberNumber = (int) ($member['medlemsnummer'] ?? 0);
        $payments = $memberNumber > 0 ? $this->paymentsByMonth($memberNumber) : [];
        $stripe = $this->stripeState($memberId);
        $status = $this->evaluateMember($member, $payments, (bool) ($stripe['active'] ?? false));

        $needsPatternFollowUp = in_array($status['code'], ['mulig_fast', 'tidligere_fast'], true)
            && !(bool) ($stripe['active'] ?? false);
        $needsFollowUp = (float) ($status['arrears'] ?? 0.0) > 0.001
            || (bool) ($stripe['problem'] ?? false)
            || $needsPatternFollowUp;

        return [
            'member_id' => $memberId,
            'member_number' => $memberNumber > 0 ? $memberNumber : null,
            'code' => (string) $status['code'],
            'label' => (string) $status['label'],
            'reason' => (string) $status['reason'],
            'is_active_member' => (string) $status['code'] !== 'inaktiv',
            'manual' => (bool) ($status['manual'] ?? false),
            'monthly_amount' => (float) $status['monthlyAmount'],
            'paid_current' => (bool) $status['paidCurrent'],
            'current_amount' => round((float) $status['currentAmount'], 2),
            'current_period' => $this->monthKey($this->currentMonth()),
            'current_period_label' => $this->periodLabel($this->currentMonth()),
            'paid_previous' => (bool) $status['paidPrevious'],
            'previous_amount' => round((float) $status['previousAmount'], 2),
            'previous_period' => $this->monthKey($status['previousMonth']),
            'previous_period_label' => $this->periodLabel($status['previousMonth']),
            'latest_paid_period' => $this->dateKey($status['latestPaidPeriod'] ?? null),
            'latest_paid_period_label' => ($status['latestPaidPeriod'] ?? null) instanceof DateTimeInterface
                ? $this->periodLabel($status['latestPaidPeriod'])
                : null,
            'missing_count' => (int) ($status['missingCount'] ?? 0),
            'missing' => $this->serializeMissing($status['missing'] ?? []),
            'historical_missing_count' => (int) ($status['historicalMissingCount'] ?? 0),
            'historical_missing' => $this->serializeMissing($status['historicalMissing'] ?? []),
            'arrears' => round((float) ($status['arrears'] ?? 0.0), 2),
            'needs_follow_up' => $needsFollowUp,
            'stripe' => $stripe,
        ];
    }

    /** @return array<string,float> */
    private function paymentsByMonth(int $memberNumber): array
    {
        $statement = $this->connection->prepare(
            'SELECT periode, SUM(belop) AS paid
             FROM `kontingentbetalinger`
             WHERE medlemsnummer=?
             GROUP BY periode'
        );
        $statement->bind_param('i', $memberNumber);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        $payments = [];
        foreach ($rows as $row) {
            $period = trim((string) ($row['periode'] ?? ''));
            if (preg_match('/^(0[1-9]|1[0-2])-(\d{2})$/', $period, $match) !== 1) {
                continue;
            }
            $payments[sprintf('20%02d-%02d', (int) $match[2], (int) $match[1])] = (float) ($row['paid'] ?? 0.0);
        }
        return $payments;
    }

    /** @return array<string,mixed>|null */
    private function stripeState(int $memberId): ?array
    {
        if (!$this->tableExists('stripe_abonnementer')) {
            return null;
        }

        $statement = $this->connection->prepare(
            "SELECT status, cancel_at_period_end, ended_at, updated_at
             FROM `stripe_abonnementer`
             WHERE member_id=?
               AND status NOT IN ('canceled','incomplete_expired')
             ORDER BY updated_at DESC, id DESC
             LIMIT 1"
        );
        $statement->bind_param('i', $memberId);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();

        if ($row === null) {
            return null;
        }

        $status = strtolower(trim((string) ($row['status'] ?? 'unknown')));
        return [
            'status' => $status,
            'active' => in_array($status, ['active', 'trialing'], true),
            'problem' => in_array($status, ['past_due', 'unpaid', 'incomplete', 'paused'], true),
            'cancel_at_period_end' => (int) ($row['cancel_at_period_end'] ?? 0) === 1,
            'ended_at' => $row['ended_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    /** @param array<string,float> $memberPayments @return array<string,mixed> */
    private function evaluateMember(array $member, array $memberPayments, bool $hasActiveAutoDebit): array
    {
        $today = new DateTimeImmutable('today');
        $currentMonth = $this->currentMonth($today);
        $lastClosed = $currentMonth->modify('-1 month');
        $monthlyAmount = max(0.01, (float) ($member['maanedsbelop'] ?? 200));

        $latestPaidPeriod = null;
        foreach ($memberPayments as $monthKey => $paidAmount) {
            if ((float) $paidAmount + 0.001 < $monthlyAmount || preg_match('/^\d{4}-\d{2}$/', (string) $monthKey) !== 1) {
                continue;
            }
            $paidMonth = new DateTimeImmutable((string) $monthKey . '-01');
            if ($latestPaidPeriod === null || $paidMonth > $latestPaidPeriod) {
                $latestPaidPeriod = $paidMonth;
            }
        }

        $startRaw = trim((string) ($member['kontingent_start'] ?? ''))
            ?: trim((string) ($member['innmeldingsdato'] ?? ''))
            ?: $currentMonth->format('Y-m-d');
        $configuredStart = $this->monthStart(new DateTimeImmutable($startRaw));

        $configuredEnd = null;
        if (trim((string) ($member['kontingent_slutt'] ?? '')) !== '') {
            $configuredEnd = $this->monthStart(new DateTimeImmutable((string) $member['kontingent_slutt']));
        }

        $override = (string) ($member['betalingsstatus_override'] ?? 'automatisk');
        if (!in_array($override, ['automatisk', 'fast', 'ikke_fast', 'inaktiv'], true)) {
            $override = 'automatisk';
        }

        $evaluationEnd = $configuredEnd !== null && $configuredEnd < $lastClosed
            ? $configuredEnd
            : $lastClosed;
        $dueEnd = $evaluationEnd;
        $evaluationMonths = $this->monthsBetween($configuredStart, $evaluationEnd);
        $flags = [];
        $latestFull = null;

        foreach ($evaluationMonths as $month) {
            $paid = (float) ($memberPayments[$this->monthKey($month)] ?? 0.0);
            $isFull = $paid + 0.001 >= $monthlyAmount;
            $flags[] = $isFull;
            if ($isFull) {
                $latestFull = $month;
            }
        }

        $currentAmount = (float) ($memberPayments[$this->monthKey($currentMonth)] ?? 0.0);
        $paidCurrent = $currentAmount + 0.001 >= $monthlyAmount;
        $previousAmount = (float) ($memberPayments[$this->monthKey($lastClosed)] ?? 0.0);
        $paidPrevious = $previousAmount + 0.001 >= $monthlyAmount;
        $recentFlags = array_slice($flags, -6);
        $recentCount = count($recentFlags);
        $paidRecent = count(array_filter($recentFlags));
        $streak = $this->longestStreak($recentFlags);
        $stableStart = $this->firstStableStart($evaluationMonths, $flags);
        $monthsSincePaid = $latestFull === null ? 999 : $this->monthDiff($latestFull, $evaluationEnd);

        $base = [
            'monthlyAmount' => $monthlyAmount,
            'configuredStart' => $configuredStart,
            'configuredEnd' => $configuredEnd,
            'autoFixedStart' => $stableStart,
            'latestFull' => $latestFull,
            'latestPaidPeriod' => $latestPaidPeriod,
            'lastPaid' => $latestPaidPeriod,
            'paidCurrent' => $paidCurrent,
            'currentAmount' => $currentAmount,
            'previousMonth' => $lastClosed,
            'paidPrevious' => $paidPrevious,
            'previousAmount' => $previousAmount,
            'paidRecent' => $paidRecent,
            'recentCount' => $recentCount,
            'streak' => $streak,
            'monthsSincePaid' => $monthsSincePaid,
            'lastClosed' => $lastClosed,
            'manual' => false,
            'missing' => [],
            'missingCount' => 0,
            'historicalMissing' => [],
            'historicalMissingCount' => 0,
            'arrears' => 0.0,
        ];

        if ($override === 'inaktiv') {
            return array_merge($base, [
                'code' => 'inaktiv',
                'label' => 'Inaktiv',
                'reason' => 'Manuelt satt som inaktiv',
                'manual' => true,
            ]);
        }

        if ($configuredEnd !== null && $configuredEnd < $currentMonth && $override === 'automatisk') {
            return array_merge($base, [
                'code' => 'inaktiv',
                'label' => 'Avsluttet',
                'reason' => 'Kontingentperioden ble avsluttet ' . $this->periodLabel($configuredEnd),
            ]);
        }

        $archiveInfo = $this->archiveInfo($member, $memberPayments, $today);
        if ((bool) ($archiveInfo['archived'] ?? false) && !$hasActiveAutoDebit) {
            return array_merge($base, [
                'code' => 'inaktiv',
                'label' => 'Arkivert',
                'reason' => (string) ($archiveInfo['reason'] ?? 'Tre avsluttede måneder uten betaling'),
            ]);
        }

        if ($evaluationMonths === []) {
            $auto = array_merge($base, [
                'code' => 'under_vurdering',
                'label' => 'Under vurdering',
                'reason' => 'Ingen betalingsmåneder å vurdere ennå',
            ]);
        } elseif (count($evaluationMonths) < 3) {
            $eligible = count($evaluationMonths);
            $auto = array_merge($base, [
                'code' => 'under_vurdering',
                'label' => 'Under vurdering',
                'reason' => $eligible . ' betalingsmåned' . ($eligible === 1 ? '' : 'er') . ' å vurdere',
            ]);
        } elseif ($stableStart !== null && $monthsSincePaid >= 3) {
            $auto = array_merge($base, [
                'code' => 'tidligere_fast',
                'label' => 'Tidligere fast',
                'reason' => 'Tidligere fast mønster, men ingen full betaling de siste ' . $monthsSincePaid . ' månedene',
            ]);
        } elseif ($recentCount >= 4 && $paidRecent >= 4 && $streak >= 3 && $monthsSincePaid <= 2) {
            $missingSplit = $stableStart !== null && $dueEnd >= $stableStart
                ? $this->splitMissingPeriods($stableStart, $dueEnd, $memberPayments, $monthlyAmount)
                : ['active' => [], 'historical' => []];
            $missing = $missingSplit['active'];
            $historicalMissing = $missingSplit['historical'];
            $auto = array_merge($base, [
                'code' => 'fast',
                'label' => 'Fast betaler',
                'reason' => $paidRecent . ' av ' . $recentCount . ' siste måneder fullt betalt',
                'missing' => $missing,
                'missingCount' => count($missing),
                'historicalMissing' => $historicalMissing,
                'historicalMissingCount' => count($historicalMissing),
                'arrears' => array_sum(array_column($missing, 'remaining')),
            ]);
        } elseif ($paidRecent >= 2 || $streak >= 2) {
            $auto = array_merge($base, [
                'code' => 'mulig_fast',
                'label' => 'Mulig fast',
                'reason' => $paidRecent . ' av ' . $recentCount . ' siste måneder fullt betalt',
            ]);
        } else {
            $auto = array_merge($base, [
                'code' => 'sporadisk',
                'label' => 'Sporadisk',
                'reason' => $paidRecent . ' av ' . $recentCount . ' siste måneder fullt betalt',
            ]);
        }

        if ($override === 'fast') {
            $missingSplit = $dueEnd >= $configuredStart
                ? $this->splitMissingPeriods($configuredStart, $dueEnd, $memberPayments, $monthlyAmount)
                : ['active' => [], 'historical' => []];
            $missing = $missingSplit['active'];
            $historicalMissing = $missingSplit['historical'];
            $auto['code'] = 'fast';
            $auto['label'] = 'Fast betaler';
            $auto['reason'] = 'Manuelt overstyrt til fast betaler';
            $auto['manual'] = true;
            $auto['missing'] = $missing;
            $auto['missingCount'] = count($missing);
            $auto['historicalMissing'] = $historicalMissing;
            $auto['historicalMissingCount'] = count($historicalMissing);
            $auto['arrears'] = array_sum(array_column($missing, 'remaining'));
        } elseif ($override === 'ikke_fast') {
            $auto['code'] = 'ikke_fast';
            $auto['label'] = 'Ikke fast';
            $auto['reason'] = 'Manuelt overstyrt til ikke-fast betaler';
            $auto['manual'] = true;
            $auto['missing'] = [];
            $auto['missingCount'] = 0;
            $auto['arrears'] = 0.0;
        }

        return $auto;
    }

    /** @param array<string,float> $memberPayments @return array{archived:bool,months?:array<int,DateTimeImmutable>,reason?:string} */
    private function archiveInfo(array $member, array $memberPayments, DateTimeImmutable $today): array
    {
        $currentMonth = $this->currentMonth($today);
        $lastClosed = $currentMonth->modify('-1 month');
        $startRaw = trim((string) ($member['kontingent_start'] ?? ''))
            ?: trim((string) ($member['innmeldingsdato'] ?? ''))
            ?: $currentMonth->format('Y-m-d');
        $start = $this->monthStart(new DateTimeImmutable($startRaw));

        $currentPaid = (float) ($memberPayments[$this->monthKey($currentMonth)] ?? 0.0);
        if ($currentPaid > 0.001) {
            return ['archived' => false, 'months' => []];
        }

        $months = [
            $lastClosed->modify('-2 months'),
            $lastClosed->modify('-1 month'),
            $lastClosed,
        ];
        if ($months[0] < $start) {
            return ['archived' => false, 'months' => []];
        }

        foreach ($months as $month) {
            $paid = (float) ($memberPayments[$this->monthKey($month)] ?? 0.0);
            if ($paid > 0.001) {
                return ['archived' => false, 'months' => []];
            }
        }

        return [
            'archived' => true,
            'months' => $months,
            'reason' => 'Ingen betaling registrert i ' . implode(', ', array_map(
                fn (DateTimeImmutable $month): string => $this->periodLabel($month),
                $months
            )),
        ];
    }

    /** @param list<DateTimeImmutable> $months @param list<bool> $flags */
    private function firstStableStart(array $months, array $flags): ?DateTimeImmutable
    {
        $count = count($flags);
        for ($end = 0; $end < $count; $end++) {
            $windowStart = max(0, $end - 5);
            $window = array_slice($flags, $windowStart, $end - $windowStart + 1);
            if (count($window) < 4 || count(array_filter($window)) < 4 || $this->longestStreak($window) < 3) {
                continue;
            }

            $runLength = 0;
            $runStart = null;
            foreach ($window as $index => $paid) {
                if ($paid) {
                    if ($runLength === 0) {
                        $runStart = $index;
                    }
                    $runLength++;
                    if ($runLength >= 3 && $runStart !== null) {
                        return $months[$windowStart + $runStart];
                    }
                } else {
                    $runLength = 0;
                    $runStart = null;
                }
            }
        }
        return null;
    }

    /** @param list<bool> $flags */
    private function longestStreak(array $flags): int
    {
        $best = 0;
        $current = 0;
        foreach ($flags as $flag) {
            if ($flag) {
                $current++;
                $best = max($best, $current);
            } else {
                $current = 0;
            }
        }
        return $best;
    }

    /** @param array<string,float> $memberPayments @return array{active:list<array<string,mixed>>,historical:list<array<string,mixed>>} */
    private function splitMissingPeriods(DateTimeImmutable $start, DateTimeImmutable $end, array $memberPayments, float $monthlyAmount): array
    {
        $active = [];
        $historical = [];
        foreach ($this->monthsBetween($start, $end) as $month) {
            $paid = (float) ($memberPayments[$this->monthKey($month)] ?? 0.0);
            if ($paid + 0.001 >= $monthlyAmount) {
                continue;
            }

            $item = [
                'month' => $month,
                'paid' => $paid,
                'remaining' => max(0.0, $monthlyAmount - $paid),
            ];
            $nextMonth = $month->modify('+1 month');
            $secondNextMonth = $month->modify('+2 months');
            $hasTwoClosedMonthsAfter = $secondNextMonth <= $end;
            $nextPaid = (float) ($memberPayments[$this->monthKey($nextMonth)] ?? 0.0);
            $secondNextPaid = (float) ($memberPayments[$this->monthKey($secondNextMonth)] ?? 0.0);
            $isForgiven = $hasTwoClosedMonthsAfter
                && $nextPaid + 0.001 >= $monthlyAmount
                && $secondNextPaid + 0.001 >= $monthlyAmount;

            if ($isForgiven) {
                $item['forgivenBy'] = [$nextMonth, $secondNextMonth];
                $historical[] = $item;
            } else {
                $active[] = $item;
            }
        }
        return ['active' => $active, 'historical' => $historical];
    }

    /** @return list<DateTimeImmutable> */
    private function monthsBetween(DateTimeImmutable $start, DateTimeImmutable $end): array
    {
        if ($start > $end) {
            return [];
        }
        $months = [];
        for ($cursor = $this->monthStart($start); $cursor <= $this->monthStart($end); $cursor = $cursor->modify('+1 month')) {
            $months[] = $cursor;
        }
        return $months;
    }

    private function monthDiff(DateTimeInterface $from, DateTimeInterface $to): int
    {
        return (((int) $to->format('Y') - (int) $from->format('Y')) * 12)
            + ((int) $to->format('n') - (int) $from->format('n'));
    }

    private function currentMonth(?DateTimeImmutable $today = null): DateTimeImmutable
    {
        $today ??= new DateTimeImmutable('today');
        return $this->monthStart($today);
    }

    private function monthStart(DateTimeInterface $date): DateTimeImmutable
    {
        return new DateTimeImmutable($date->format('Y-m-01'));
    }

    private function monthKey(DateTimeInterface $month): string
    {
        return $month->format('Y-m');
    }

    private function periodLabel(DateTimeInterface $month): string
    {
        $names = [
            1 => 'Januar', 2 => 'Februar', 3 => 'Mars', 4 => 'April', 5 => 'Mai', 6 => 'Juni',
            7 => 'Juli', 8 => 'August', 9 => 'September', 10 => 'Oktober', 11 => 'November', 12 => 'Desember',
        ];
        return $names[(int) $month->format('n')] . ' ' . $month->format('Y');
    }

    private function dateKey(mixed $value): ?string
    {
        return $value instanceof DateTimeInterface ? $value->format('Y-m') : null;
    }

    /** @param array<int,array<string,mixed>> $items @return list<array<string,mixed>> */
    private function serializeMissing(array $items): array
    {
        return array_values(array_map(function (array $item): array {
            $serialized = [
                'period' => $item['month'] instanceof DateTimeInterface ? $item['month']->format('Y-m') : null,
                'period_label' => $item['month'] instanceof DateTimeInterface ? $this->periodLabel($item['month']) : null,
                'paid' => round((float) ($item['paid'] ?? 0.0), 2),
                'remaining' => round((float) ($item['remaining'] ?? 0.0), 2),
            ];
            if (isset($item['forgivenBy']) && is_array($item['forgivenBy'])) {
                $serialized['forgiven_by'] = array_values(array_map(
                    static fn (mixed $month): ?string => $month instanceof DateTimeInterface ? $month->format('Y-m') : null,
                    $item['forgivenBy']
                ));
            }
            return $serialized;
        }, $items));
    }

    private function tableExists(string $table): bool
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
            throw new RuntimeException('Invalid table name.');
        }
        $statement = $this->connection->prepare(
            'SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1'
        );
        $statement->bind_param('s', $table);
        $statement->execute();
        $exists = $statement->get_result()->fetch_row() !== null;
        $statement->close();
        return $exists;
    }
}
