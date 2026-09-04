<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use InvalidArgumentException;

final class TournamentGroupService
{
    /**
     * @param array<int, array<string, mixed>> $registrations
     * @return array{mode:string,draw_seed:int,groups:array<int,array{name:string,sort_order:int,players:array<int,array<string,mixed>>}>}
     */
    public function allocate(array $registrations, int $groupCount, string $mode, ?int $drawSeed = null): array
    {
        $mode = strtolower(trim($mode));
        if (!in_array($mode, ['random', 'elo_snake', 'elo_pots'], true)) {
            throw new InvalidArgumentException('Unsupported group draw mode.');
        }

        $registrations = array_values($registrations);
        $playerCount = count($registrations);
        if ($playerCount < 2) {
            throw new InvalidArgumentException('At least two registered players are required.');
        }
        if ($groupCount < 1 || $groupCount > $playerCount) {
            throw new InvalidArgumentException('Group count must be between 1 and the number of players.');
        }
        if (intdiv($playerCount, $groupCount) < 4) {
            throw new InvalidArgumentException('Hver gruppe må ha minst 4 spillere.');
        }

        $drawSeed ??= random_int(1, PHP_INT_MAX);
        $seeded = $this->withSeedNumbers($registrations);
        $groups = [];
        for ($index = 0; $index < $groupCount; $index++) {
            $groups[$index] = [
                'name' => $this->groupName($index),
                'sort_order' => $index + 1,
                'players' => [],
            ];
        }

        if ($mode === 'elo_snake') {
            foreach ($seeded as $index => $player) {
                $cycle = intdiv($index, $groupCount);
                $offset = $index % $groupCount;
                $groupIndex = $cycle % 2 === 0 ? $offset : ($groupCount - 1 - $offset);
                $groups[$groupIndex]['players'][] = $player;
            }
        } elseif ($mode === 'elo_pots') {
            foreach (array_chunk($seeded, $groupCount) as $potIndex => $pot) {
                usort($pot, fn (array $a, array $b): int => $this->randomKey($drawSeed, $potIndex, $a) <=> $this->randomKey($drawSeed, $potIndex, $b));
                foreach ($pot as $offset => $player) {
                    $groups[$offset]['players'][] = $player;
                }
            }
        } else {
            $randomized = $seeded;
            usort($randomized, fn (array $a, array $b): int => $this->randomKey($drawSeed, 0, $a) <=> $this->randomKey($drawSeed, 0, $b));
            foreach ($randomized as $index => $player) {
                $groups[$index % $groupCount]['players'][] = $player;
            }
        }

        foreach ($groups as &$group) {
            foreach ($group['players'] as $position => &$player) {
                $player['group_position'] = $position + 1;
            }
            unset($player);
        }
        unset($group);

        return [
            'mode' => $mode,
            'draw_seed' => $drawSeed,
            'groups' => $groups,
        ];
    }

    /**
     * @param array<int, array<string, mixed>> $players
     * @return array<int, array<int, array{player_a_id:int,player_b_id:int}>>
     */
    public function roundRobin(array $players): array
    {
        $ids = array_values(array_map(static fn (array $player): int => (int) ($player['player_id'] ?? 0), $players));
        $ids = array_values(array_filter($ids, static fn (int $id): bool => $id > 0));
        if (count($ids) < 2) {
            return [];
        }

        if (count($ids) % 2 === 1) {
            $ids[] = 0;
        }

        $roundCount = count($ids) - 1;
        $half = intdiv(count($ids), 2);
        $rounds = [];

        for ($round = 0; $round < $roundCount; $round++) {
            $pairs = [];
            for ($index = 0; $index < $half; $index++) {
                $a = $ids[$index];
                $b = $ids[count($ids) - 1 - $index];
                if ($a > 0 && $b > 0) {
                    if ($round % 2 === 1 && $index === 0) {
                        [$a, $b] = [$b, $a];
                    }
                    $pairs[] = ['player_a_id' => $a, 'player_b_id' => $b];
                }
            }
            $rounds[] = $pairs;

            $fixed = array_shift($ids);
            $last = array_pop($ids);
            array_unshift($ids, $last);
            array_unshift($ids, $fixed);
        }

        return $rounds;
    }

    /**
     * @param array<int, array<string, mixed>> $players
     * @return array<int, array<string, mixed>>
     */
    private function withSeedNumbers(array $players): array
    {
        usort($players, static function (array $a, array $b): int {
            $ratingCompare = ((float) ($b['elo_rating'] ?? 1000.0)) <=> ((float) ($a['elo_rating'] ?? 1000.0));
            if ($ratingCompare !== 0) {
                return $ratingCompare;
            }
            $nameCompare = strcasecmp((string) ($a['display_name'] ?? ''), (string) ($b['display_name'] ?? ''));
            if ($nameCompare !== 0) {
                return $nameCompare;
            }
            return ((int) ($a['player_id'] ?? 0)) <=> ((int) ($b['player_id'] ?? 0));
        });

        foreach ($players as $index => &$player) {
            $player['seed_number'] = $index + 1;
            $player['seed_rating'] = (float) ($player['elo_rating'] ?? 1000.0);
        }
        unset($player);

        return $players;
    }

    /** @param array<string, mixed> $player */
    private function randomKey(int $drawSeed, int $potIndex, array $player): string
    {
        return hash('sha256', $drawSeed . ':' . $potIndex . ':' . (int) ($player['player_id'] ?? 0));
    }

    private function groupName(int $index): string
    {
        $name = '';
        $value = $index;
        do {
            $name = chr(65 + ($value % 26)) . $name;
            $value = intdiv($value, 26) - 1;
        } while ($value >= 0);
        return 'Gruppe ' . $name;
    }
}
