<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\ValidationException;

final class ScoliaSectorMapper
{
    /** @return array{multiplier:string,value:int|string,label:string,score:int} */
    public function toCanonical(string $sector, bool $bounceout = false): array
    {
        $sector = trim($sector);
        if ($bounceout || $sector === '' || strcasecmp($sector, 'None') === 0) {
            return ['multiplier' => 'S', 'value' => 0, 'label' => 'MISS', 'score' => 0];
        }

        if ($sector === '25') {
            return ['multiplier' => 'S', 'value' => 'BULL', 'label' => '25', 'score' => 25];
        }

        if (strcasecmp($sector, 'Bull') === 0) {
            return ['multiplier' => 'D', 'value' => 'BULL', 'label' => 'BULL', 'score' => 50];
        }

        if (preg_match('/^([sSdDtT])(\d{1,2})$/', $sector, $match) !== 1) {
            throw new ValidationException('invalid_scolia_sector', 'Scolia sendte en ukjent sektor: ' . $sector, 422);
        }

        $number = (int) $match[2];
        if ($number < 1 || $number > 20) {
            throw new ValidationException('invalid_scolia_sector', 'Scolia sendte en sektor utenfor 1–20.', 422);
        }

        $multiplier = strtoupper($match[1]);
        if ($multiplier === 'S') {
            return ['multiplier' => 'S', 'value' => $number, 'label' => (string) $number, 'score' => $number];
        }
        if ($multiplier === 'D') {
            return ['multiplier' => 'D', 'value' => $number, 'label' => 'D' . $number, 'score' => $number * 2];
        }
        return ['multiplier' => 'T', 'value' => $number, 'label' => 'T' . $number, 'score' => $number * 3];
    }
}
