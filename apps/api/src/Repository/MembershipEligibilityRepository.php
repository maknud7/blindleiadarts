<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use DateTimeImmutable;
use mysqli;
use RuntimeException;

final class MembershipEligibilityRepository
{
    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $this->safePrefix($database->tablePrefix());
    }

    /** @return array<string,mixed> */
    public function forPlayer(int $playerId): array
    {
        if ($playerId <= 0) {
            return $this->unavailable('player_missing');
        }

        $players = $this->prefix . 'players';
        $stmt = $this->connection->prepare(
            "SELECT id, club_id, member_id, display_name FROM `{$players}` WHERE id = ? LIMIT 1"
        );
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $player = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($player === null) {
            return $this->unavailable('player_not_found');
        }

        $clubId = (int) ($player['club_id'] ?? 0);
        $memberId = (int) ($player['member_id'] ?? 0);
        if ($memberId <= 0) {
            return array_merge($this->unavailable('member_not_linked'), [
                'club_id' => $clubId > 0 ? $clubId : null,
                'player_id' => $playerId,
            ]);
        }

        $memberStmt = $this->connection->prepare(
            'SELECT id, medlemsnummer, navn, innmeldingsdato, betalingsstatus_override, kontingent_start, kontingent_slutt, maanedsbelop
               FROM `medlemmer` WHERE id = ? LIMIT 1'
        );
        $memberStmt->bind_param('i', $memberId);
        $memberStmt->execute();
        $member = $memberStmt->get_result()->fetch_assoc() ?: null;
        $memberStmt->close();

        if ($member === null) {
            return array_merge($this->unavailable('member_not_found'), [
                'club_id' => $clubId > 0 ? $clubId : null,
                'player_id' => $playerId,
                'member_id' => $memberId,
            ]);
        }

        $today = new DateTimeImmutable('today');
        $currentMonth = new DateTimeImmutable($today->format('Y-m-01'));
        $previousMonth = $currentMonth->modify('-1 month');
        $monthlyAmount = max(0.01, (float) ($member['maanedsbelop'] ?? 200));
        $startRaw = trim((string) ($member['kontingent_start'] ?? ''))
            ?: trim((string) ($member['innmeldingsdato'] ?? ''))
            ?: $currentMonth->format('Y-m-d');
        $duesStart = new DateTimeImmutable((new DateTimeImmutable($startRaw))->format('Y-m-01'));
        $duesEnd = null;
        if (trim((string) ($member['kontingent_slutt'] ?? '')) !== '') {
            $duesEndValue = new DateTimeImmutable((string) $member['kontingent_slutt']);
            $duesEnd = new DateTimeImmutable($duesEndValue->format('Y-m-01'));
        }

        $memberNumber = (int) ($member['medlemsnummer'] ?? 0);
        $payments = $memberNumber > 0 ? $this->paymentsByMonth($memberNumber) : [];
        $currentPaid = (float) ($payments[$currentMonth->format('Y-m')] ?? 0.0);
        $previousPaid = (float) ($payments[$previousMonth->format('Y-m')] ?? 0.0);
        $currentRemaining = max(0.0, $monthlyAmount - $currentPaid);
        $previousRemaining = max(0.0, $monthlyAmount - $previousPaid);
        $stripe = $this->stripeState($memberId);
        $activeStripe = (bool) ($stripe['active'] ?? false);
        $stripeProblem = (bool) ($stripe['problem'] ?? false);
        $blockAfter = $this->blockAfterMissedMonths($clubId);
        $missedClosedMonths = $this->consecutiveUnpaidClosedMonths($payments, $previousMonth, $duesStart, $duesEnd);
        $override = strtolower(trim((string) ($member['betalingsstatus_override'] ?? 'automatisk')));
        $base = [
            'player_id' => $playerId,
            'club_id' => $clubId > 0 ? $clubId : null,
            'member_id' => $memberId,
            'member_number' => $memberNumber > 0 ? $memberNumber : null,
            'monthly_amount' => $monthlyAmount,
            'current_period' => $currentMonth->format('Y-m'),
            'current_period_label' => $this->periodLabel($currentMonth),
            'current_paid' => round($currentPaid, 2),
            'current_remaining' => round($currentRemaining, 2),
            'previous_period' => $previousMonth->format('Y-m'),
            'previous_period_label' => $this->periodLabel($previousMonth),
            'previous_paid' => round($previousPaid, 2),
            'previous_remaining' => round($previousRemaining, 2),
            'missed_closed_months' => $missedClosedMonths,
            'block_after_missed_months' => $blockAfter,
            'stripe' => $stripe,
        ];

        if ($override === 'inaktiv' || ($duesEnd !== null && $duesEnd < $currentMonth)) {
            return array_merge($base, [
                'status' => 'blocked',
                'reason_code' => 'membership_inactive',
                'can_register' => false,
                'action_required' => true,
                'headline' => 'Medlemskapet må avklares',
                'message' => 'Medlemskapet står som inaktivt. Kontakt klubben før du melder deg på nye turneringer.',
            ]);
        }

        if ($override === 'ikke_fast') {
            return array_merge($base, [
                'status' => 'exempt',
                'reason_code' => 'payment_not_required',
                'can_register' => true,
                'action_required' => false,
                'headline' => null,
                'message' => null,
            ]);
        }

        if ($duesStart > $currentMonth) {
            return array_merge($base, [
                'status' => 'not_due',
                'reason_code' => 'dues_not_started',
                'can_register' => true,
                'action_required' => false,
                'headline' => null,
                'message' => null,
            ]);
        }

        // Samme prinsipp som i Blindleia-admin: en betaling i inneværende måned
        // reaktiverer medlemskapet selv om de tre foregående månedene manglet.
        $hasCurrentPayment = $currentPaid > 0.001;
        if (!$activeStripe && !$hasCurrentPayment && $blockAfter > 0 && $missedClosedMonths >= $blockAfter) {
            return array_merge($base, [
                'status' => 'blocked',
                'reason_code' => 'payment_too_far_overdue',
                'can_register' => false,
                'action_required' => true,
                'headline' => 'Kontingenten må ordnes',
                'message' => sprintf(
                    'Vi har ikke registrert betaling de siste %d avsluttede månedene. Ordne kontingenten før du melder deg på nye turneringer.',
                    $missedClosedMonths
                ),
            ]);
        }

        if ($stripeProblem) {
            return array_merge($base, [
                'status' => 'payment_problem',
                'reason_code' => 'stripe_needs_attention',
                'can_register' => true,
                'action_required' => true,
                'headline' => 'Fast betaling trenger oppfølging',
                'message' => 'Stripe-avtalen krever oppfølging. Du kan fortsatt melde deg på, men betalingsavtalen bør ordnes.',
            ]);
        }

        if ($activeStripe) {
            return array_merge($base, [
                'status' => 'ok',
                'reason_code' => 'active_autodebit',
                'can_register' => true,
                'action_required' => false,
                'headline' => null,
                'message' => null,
            ]);
        }

        if ($previousMonth >= $duesStart && $previousRemaining > 0.001) {
            return array_merge($base, [
                'status' => 'overdue',
                'reason_code' => 'previous_period_incomplete',
                'can_register' => true,
                'action_required' => true,
                'headline' => 'Kontingent mangler',
                'message' => sprintf(
                    '%s er ikke fullt registrert. Du kan fortsatt melde deg på nå, men betalingen bør ordnes.',
                    $this->periodLabel($previousMonth)
                ),
            ]);
        }

        if ($currentRemaining > 0.001) {
            return array_merge($base, [
                'status' => 'due',
                'reason_code' => 'current_period_incomplete',
                'can_register' => true,
                'action_required' => true,
                'headline' => 'Kontingent denne måneden',
                'message' => sprintf(
                    'Vi mangler %s for %s. Påmelding er fortsatt åpen.',
                    $this->money($currentRemaining),
                    mb_strtolower($this->periodLabel($currentMonth), 'UTF-8')
                ),
            ]);
        }

        return array_merge($base, [
            'status' => 'ok',
            'reason_code' => 'paid',
            'can_register' => true,
            'action_required' => false,
            'headline' => null,
            'message' => null,
        ]);
    }

    /** @return array<string,mixed> */
    private function unavailable(string $reason): array
    {
        return [
            'status' => 'unavailable',
            'reason_code' => $reason,
            'can_register' => true,
            'action_required' => false,
            'headline' => null,
            'message' => null,
        ];
    }

    /** @return array<string,float> */
    private function paymentsByMonth(int $memberNumber): array
    {
        $stmt = $this->connection->prepare(
            'SELECT periode, SUM(belop) AS paid FROM `kontingentbetalinger` WHERE medlemsnummer = ? GROUP BY periode'
        );
        $stmt->bind_param('i', $memberNumber);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $payments = [];
        foreach ($rows as $row) {
            $period = trim((string) ($row['periode'] ?? ''));
            if (preg_match('/^(0[1-9]|1[0-2])-(\d{2})$/', $period, $matches) !== 1) {
                continue;
            }
            $key = sprintf('20%02d-%02d', (int) $matches[2], (int) $matches[1]);
            $payments[$key] = (float) ($row['paid'] ?? 0.0);
        }
        return $payments;
    }

    /** @return array<string,mixed>|null */
    private function stripeState(int $memberId): ?array
    {
        if (!$this->tableExists('stripe_abonnementer')) {
            return null;
        }
        $stmt = $this->connection->prepare(
            'SELECT status, cancel_at_period_end, ended_at, updated_at FROM `stripe_abonnementer`
              WHERE member_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1'
        );
        $stmt->bind_param('i', $memberId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
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

    /** @param array<string,float> $payments */
    private function consecutiveUnpaidClosedMonths(array $payments, DateTimeImmutable $lastClosed, DateTimeImmutable $duesStart, ?DateTimeImmutable $duesEnd): int
    {
        $count = 0;
        $cursor = $lastClosed;
        if ($duesEnd !== null && $duesEnd < $cursor) {
            $cursor = $duesEnd;
        }
        for ($guard = 0; $guard < 24 && $cursor >= $duesStart; $guard++, $cursor = $cursor->modify('-1 month')) {
            $paid = (float) ($payments[$cursor->format('Y-m')] ?? 0.0);
            if ($paid > 0.001) {
                break;
            }
            $count++;
        }
        return $count;
    }

    private function blockAfterMissedMonths(int $clubId): int
    {
        if ($clubId <= 0) {
            return 3;
        }
        $settings = $this->prefix . 'settings';
        $key = 'membership.registration_block_after_missed_months';
        $stmt = $this->connection->prepare("SELECT setting_value FROM `{$settings}` WHERE club_id = ? AND setting_key = ? LIMIT 1");
        $stmt->bind_param('is', $clubId, $key);
        $stmt->execute();
        $value = $stmt->get_result()->fetch_assoc()['setting_value'] ?? null;
        $stmt->close();
        if ($value === null || trim((string) $value) === '') {
            return 3;
        }
        return max(0, min(12, (int) $value));
    }

    private function periodLabel(DateTimeImmutable $month): string
    {
        $months = [1 => 'Januar', 2 => 'Februar', 3 => 'Mars', 4 => 'April', 5 => 'Mai', 6 => 'Juni', 7 => 'Juli', 8 => 'August', 9 => 'September', 10 => 'Oktober', 11 => 'November', 12 => 'Desember'];
        return $months[(int) $month->format('n')] . ' ' . $month->format('Y');
    }

    private function money(float $amount): string
    {
        return number_format($amount, abs($amount - round($amount)) < 0.001 ? 0 : 2, ',', ' ') . ' kr';
    }

    private function tableExists(string $table): bool
    {
        $stmt = $this->connection->prepare(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1'
        );
        $stmt->bind_param('s', $table);
        $stmt->execute();
        $exists = $stmt->get_result()->fetch_row() !== null;
        $stmt->close();
        return $exists;
    }

    private function safePrefix(string $prefix): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid database table prefix.');
        }
        return $prefix;
    }
}
