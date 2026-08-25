<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\ValidationException;

final class Dart501Rules
{
    /**
     * @param array<string, mixed> $payload
     * @return array{input_mode:string,score:int,darts_used:int,darts:array<int,array<string,mixed>>,is_bust:bool,is_checkout:bool,remaining_after:int}
     */
    public function evaluateVisit(int $remainingBefore, array $payload): array
    {
        if ($remainingBefore < 2 || $remainingBefore > 501) {
            throw new ValidationException('invalid_remaining_score', 'Ugyldig gjenstående score før kastet.');
        }

        $inputMode = strtolower(trim((string) ($payload['input_mode'] ?? 'sum')));
        if (!in_array($inputMode, ['sum', 'per_dart'], true)) {
            throw new ValidationException('invalid_input_mode', 'Scoringmodus må være sum eller per_dart.');
        }

        if ($inputMode === 'per_dart') {
            return $this->evaluatePerDart($remainingBefore, $payload);
        }

        return $this->evaluateSum($remainingBefore, $payload);
    }

    public function isCheckoutNumber(int $remaining): bool
    {
        if ($remaining <= 1 || $remaining > 170) {
            return false;
        }

        return !in_array($remaining, [159, 162, 163, 165, 166, 168, 169], true);
    }

    public function isPossibleVisitScore(int $score): bool
    {
        static $possibleScores = null;

        if (!is_array($possibleScores)) {
            $singleDartScores = [0, 25, 50];
            for ($value = 1; $value <= 20; $value++) {
                $singleDartScores[] = $value;
                $singleDartScores[] = $value * 2;
                $singleDartScores[] = $value * 3;
            }

            $singleDartScores = array_values(array_unique($singleDartScores));
            $possibleScores = [];
            foreach ($singleDartScores as $first) {
                foreach ($singleDartScores as $second) {
                    foreach ($singleDartScores as $third) {
                        $possibleScores[$first + $second + $third] = true;
                    }
                }
            }
        }

        return isset($possibleScores[$score]);
    }

    /** @param array<string, mixed> $payload */
    private function evaluateSum(int $remainingBefore, array $payload): array
    {
        $score = (int) ($payload['score'] ?? -1);
        $dartsUsed = (int) ($payload['darts_used'] ?? 3);

        if ($score < 0 || $score > 180 || !$this->isPossibleVisitScore($score)) {
            throw new ValidationException('invalid_visit_score', 'Denne summen kan ikke oppnås med tre piler.');
        }
        if ($dartsUsed < 1 || $dartsUsed > 3) {
            throw new ValidationException('invalid_darts_used', 'Antall brukte piler må være mellom 1 og 3.');
        }

        $remainingAfter = $remainingBefore - $score;
        $isBust = $remainingAfter < 0 || $remainingAfter === 1;
        $isCheckout = false;

        if ($remainingAfter === 0) {
            if ($this->isCheckoutNumber($remainingBefore)) {
                $isCheckout = true;
            } else {
                $isBust = true;
            }
        }

        if ($isBust) {
            $remainingAfter = $remainingBefore;
        }

        return [
            'input_mode' => 'sum',
            'score' => $score,
            'darts_used' => $dartsUsed,
            'darts' => [],
            'is_bust' => $isBust,
            'is_checkout' => $isCheckout,
            'remaining_after' => $remainingAfter,
        ];
    }

    /** @param array<string, mixed> $payload */
    private function evaluatePerDart(int $remainingBefore, array $payload): array
    {
        $rawDarts = is_array($payload['darts'] ?? null) ? array_values($payload['darts']) : [];
        $dartsUsed = (int) ($payload['darts_used'] ?? count($rawDarts));

        if ($dartsUsed < 1 || $dartsUsed > 3 || count($rawDarts) !== $dartsUsed) {
            throw new ValidationException('invalid_darts_used', 'Per-pil scoring må inneholde nøyaktig de pilene som er brukt.');
        }

        $darts = [];
        $score = 0;
        $remaining = $remainingBefore;
        $isBust = false;
        $isCheckout = false;

        foreach ($rawDarts as $index => $rawDart) {
            if (!is_array($rawDart)) {
                throw new ValidationException('invalid_dart', 'Ugyldig pilformat.');
            }

            $dart = $this->normalizeDart($rawDart);
            $darts[] = $dart;
            $dartScore = $this->dartScore($dart);
            $score += $dartScore;
            $next = $remaining - $dartScore;

            if ($next < 0 || $next === 1) {
                $isBust = true;
                break;
            }

            if ($next === 0) {
                if (!$this->isDouble($dart)) {
                    $isBust = true;
                    break;
                }
                if ($index !== count($rawDarts) - 1) {
                    throw new ValidationException('darts_after_checkout', 'Det kan ikke registreres flere piler etter checkout.');
                }
                $isCheckout = true;
                $remaining = 0;
                break;
            }

            $remaining = $next;
        }

        if ($score > 180) {
            throw new ValidationException('invalid_visit_score', 'Et kast kan ikke gi mer enn 180 poeng.');
        }

        return [
            'input_mode' => 'per_dart',
            'score' => $score,
            'darts_used' => $dartsUsed,
            'darts' => $darts,
            'is_bust' => $isBust,
            'is_checkout' => $isCheckout,
            'remaining_after' => $isBust ? $remainingBefore : $remaining,
        ];
    }

    /** @param array<string, mixed> $dart @return array{multiplier:string,value:int|string} */
    private function normalizeDart(array $dart): array
    {
        $multiplier = strtoupper(trim((string) ($dart['multiplier'] ?? $dart['m'] ?? 'S')));
        if (!in_array($multiplier, ['S', 'D', 'T'], true)) {
            throw new ValidationException('invalid_dart_multiplier', 'Ugyldig multiplikator på pil.');
        }

        $value = $dart['value'] ?? $dart['v'] ?? null;
        if (is_string($value) && strtoupper(trim($value)) === 'BULL') {
            if ($multiplier === 'T') {
                throw new ValidationException('invalid_bull_multiplier', 'Bull kan bare registreres som 25 eller dobbel bull.');
            }
            return ['multiplier' => $multiplier, 'value' => 'BULL'];
        }

        if (!is_numeric($value)) {
            throw new ValidationException('invalid_dart_value', 'Ugyldig verdi på pil.');
        }

        $numeric = (int) $value;
        if ($numeric === 0) {
            if ($multiplier !== 'S') {
                throw new ValidationException('invalid_miss_multiplier', 'Bom kan ikke ha dobbel eller trippel multiplikator.');
            }
            return ['multiplier' => 'S', 'value' => 0];
        }
        if ($numeric < 1 || $numeric > 20) {
            throw new ValidationException('invalid_dart_value', 'Pilverdien må være 1–20, 25/bull eller bom.');
        }

        return ['multiplier' => $multiplier, 'value' => $numeric];
    }

    /** @param array{multiplier:string,value:int|string} $dart */
    private function dartScore(array $dart): int
    {
        if ($dart['value'] === 'BULL') {
            return $dart['multiplier'] === 'D' ? 50 : 25;
        }

        $value = (int) $dart['value'];
        return match ($dart['multiplier']) {
            'D' => $value * 2,
            'T' => $value * 3,
            default => $value,
        };
    }

    /** @param array{multiplier:string,value:int|string} $dart */
    private function isDouble(array $dart): bool
    {
        return $dart['multiplier'] === 'D';
    }
}
