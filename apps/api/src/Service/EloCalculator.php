<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

final class EloCalculator
{
    public function __construct(
        private readonly float $divisor = 400.0,
        private readonly float $provisionalK = 25.0,
        private readonly float $establishedK = 15.0,
        private readonly int $provisionalMatchLimit = 10
    ) {
    }

    /**
     * @return array{
     *   rating_a_before:float,rating_b_before:float,
     *   rating_a_after:float,rating_b_after:float,
     *   delta_a:float,delta_b:float,
     *   expected_a:float,expected_b:float,
     *   k_a:float,k_b:float,
     *   matches_before_a:int,matches_before_b:int,
     *   matches_after_a:int,matches_after_b:int
     * }
     */
    public function calculate(
        float $ratingA,
        float $ratingB,
        int $matchesBeforeA,
        int $matchesBeforeB,
        float $scoreA
    ): array {
        $scoreA = max(0.0, min(1.0, $scoreA));
        $scoreB = 1.0 - $scoreA;
        $expectedA = 1.0 / (1.0 + (10.0 ** (($ratingB - $ratingA) / $this->divisor)));
        $expectedB = 1.0 - $expectedA;
        $kA = $matchesBeforeA <= $this->provisionalMatchLimit ? $this->provisionalK : $this->establishedK;
        $kB = $matchesBeforeB <= $this->provisionalMatchLimit ? $this->provisionalK : $this->establishedK;
        $deltaA = $kA * ($scoreA - $expectedA);
        $deltaB = $kB * ($scoreB - $expectedB);

        return [
            'rating_a_before' => $ratingA,
            'rating_b_before' => $ratingB,
            'rating_a_after' => $ratingA + $deltaA,
            'rating_b_after' => $ratingB + $deltaB,
            'delta_a' => $deltaA,
            'delta_b' => $deltaB,
            'expected_a' => $expectedA,
            'expected_b' => $expectedB,
            'k_a' => $kA,
            'k_b' => $kB,
            'matches_before_a' => $matchesBeforeA,
            'matches_before_b' => $matchesBeforeB,
            'matches_after_a' => $matchesBeforeA + 1,
            'matches_after_b' => $matchesBeforeB + 1,
        ];
    }
}
