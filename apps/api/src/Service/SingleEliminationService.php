<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use InvalidArgumentException;

final class SingleEliminationService
{
    public const MAX_BRACKET_SIZE = 32;

    public function bracketSize(int $qualifierCount): int
    {
        if ($qualifierCount < 2) {
            throw new InvalidArgumentException('At least two qualified players are required for a playoff.');
        }
        $size = 2;
        while ($size < $qualifierCount) {
            $size *= 2;
        }
        if ($size > self::MAX_BRACKET_SIZE) {
            throw new InvalidArgumentException('The first playoff version supports at most 32 qualified players.');
        }
        return $size;
    }

    /** @return array<int,int> */
    public function seedOrder(int $bracketSize): array
    {
        if ($bracketSize < 2 || ($bracketSize & ($bracketSize - 1)) !== 0) {
            throw new InvalidArgumentException('Bracket size must be a power of two.');
        }
        if ($bracketSize === 2) {
            return [1, 2];
        }

        $previous = $this->seedOrder(intdiv($bracketSize, 2));
        $order = [];
        foreach ($previous as $seed) {
            $order[] = $seed;
            $order[] = $bracketSize + 1 - $seed;
        }
        return $order;
    }

    public function roundCount(int $bracketSize): int
    {
        if ($bracketSize < 2 || ($bracketSize & ($bracketSize - 1)) !== 0) {
            throw new InvalidArgumentException('Bracket size must be a power of two.');
        }
        return (int) round(log($bracketSize, 2));
    }

    public function roundLabel(int $bracketSize, int $roundNumber): string
    {
        $rounds = $this->roundCount($bracketSize);
        if ($roundNumber < 1 || $roundNumber > $rounds) {
            throw new InvalidArgumentException('Invalid playoff round number.');
        }
        $remaining = intdiv($bracketSize, 2 ** ($roundNumber - 1));
        return match ($remaining) {
            2 => 'Finale',
            4 => 'Semifinale',
            8 => 'Kvartfinale',
            16 => 'Åttedelsfinale',
            32 => 'Sekstendelsfinale',
            default => 'Sluttspillrunde ' . $roundNumber,
        };
    }

    /**
     * Seed group winners before runners-up etc. Within the same group position,
     * performance decides the order using the exact group-table tie breakers.
     * Seeds inside the same qualification tier may then swap to avoid an
     * immediate rematch from the same group where that is possible.
     *
     * @param array<int,array<string,mixed>> $qualifiers
     * @return array<int,array<string,mixed>>
     */
    public function seedQualifiers(array $qualifiers): array
    {
        usort($qualifiers, static function (array $a, array $b): int {
            $position = ((int) ($a['source_group_position'] ?? 999)) <=> ((int) ($b['source_group_position'] ?? 999));
            if ($position !== 0) {
                return $position;
            }
            foreach (['points', 'leg_diff', 'legs_won'] as $field) {
                $cmp = ((int) ($b[$field] ?? 0)) <=> ((int) ($a[$field] ?? 0));
                if ($cmp !== 0) {
                    return $cmp;
                }
            }
            $seedA = $a['seed_number'] ?? null;
            $seedB = $b['seed_number'] ?? null;
            if ($seedA !== null || $seedB !== null) {
                $cmp = ((int) ($seedA ?? PHP_INT_MAX)) <=> ((int) ($seedB ?? PHP_INT_MAX));
                if ($cmp !== 0) {
                    return $cmp;
                }
            }
            return strcasecmp((string) ($a['display_name'] ?? ''), (string) ($b['display_name'] ?? ''));
        });

        foreach ($qualifiers as $index => &$qualifier) {
            $qualifier['playoff_seed'] = $index + 1;
        }
        unset($qualifier);

        $qualifiers = $this->reduceSameGroupFirstRoundConflicts($qualifiers);
        usort($qualifiers, static fn (array $a, array $b): int => ((int) $a['playoff_seed']) <=> ((int) $b['playoff_seed']));
        return $qualifiers;
    }

    /** @param array<int,array<string,mixed>> $qualifiers @return array<int,array<string,mixed>> */
    private function reduceSameGroupFirstRoundConflicts(array $qualifiers): array
    {
        if (count($qualifiers) < 3) {
            return $qualifiers;
        }

        $bestConflicts = $this->firstRoundConflictCount($qualifiers);
        if ($bestConflicts === 0) {
            return $qualifiers;
        }

        for ($iteration = 0; $iteration < 20 && $bestConflicts > 0; $iteration++) {
            $bestSwap = null;
            $bestDistance = PHP_INT_MAX;
            for ($i = 0, $count = count($qualifiers); $i < $count; $i++) {
                for ($j = $i + 1; $j < $count; $j++) {
                    if ((int) ($qualifiers[$i]['source_group_position'] ?? -1)
                        !== (int) ($qualifiers[$j]['source_group_position'] ?? -2)) {
                        continue;
                    }
                    $candidate = $qualifiers;
                    $seedI = (int) $candidate[$i]['playoff_seed'];
                    $seedJ = (int) $candidate[$j]['playoff_seed'];
                    $candidate[$i]['playoff_seed'] = $seedJ;
                    $candidate[$j]['playoff_seed'] = $seedI;
                    $conflicts = $this->firstRoundConflictCount($candidate);
                    $distance = abs($seedI - $seedJ);
                    if ($conflicts < $bestConflicts
                        || ($conflicts === $bestConflicts && $bestSwap !== null && $distance < $bestDistance)) {
                        $bestSwap = [$i, $j, $conflicts];
                        $bestDistance = $distance;
                    }
                }
            }
            if ($bestSwap === null || $bestSwap[2] >= $bestConflicts) {
                break;
            }
            [$i, $j, $bestConflicts] = $bestSwap;
            $seedI = (int) $qualifiers[$i]['playoff_seed'];
            $qualifiers[$i]['playoff_seed'] = (int) $qualifiers[$j]['playoff_seed'];
            $qualifiers[$j]['playoff_seed'] = $seedI;
        }
        return $qualifiers;
    }

    /** @param array<int,array<string,mixed>> $qualifiers */
    private function firstRoundConflictCount(array $qualifiers): int
    {
        $size = $this->bracketSize(count($qualifiers));
        $order = $this->seedOrder($size);
        $bySeed = [];
        foreach ($qualifiers as $qualifier) {
            $bySeed[(int) $qualifier['playoff_seed']] = $qualifier;
        }
        $conflicts = 0;
        for ($slot = 0; $slot < count($order); $slot += 2) {
            $a = $bySeed[$order[$slot]] ?? null;
            $b = $bySeed[$order[$slot + 1]] ?? null;
            if ($a === null || $b === null) {
                continue;
            }
            if ((int) ($a['source_group_id'] ?? 0) > 0
                && (int) ($a['source_group_id'] ?? 0) === (int) ($b['source_group_id'] ?? -1)) {
                $conflicts++;
            }
        }
        return $conflicts;
    }
}
