<?php

declare(strict_types=1);

final class DartsAtlasLiveProjector
{
    private readonly string $prefix;

    public function __construct(
        private readonly mysqli $db,
        string $tablePrefix,
    ) {
        if ($tablePrefix !== '' && !preg_match('/^[A-Za-z0-9_]+$/', $tablePrefix)) {
            throw new InvalidArgumentException('Unsafe table prefix.');
        }
        $this->prefix = $tablePrefix;
    }

    public function project(int $matchId, array $externalToLocalPlayer, array $broadcast): bool
    {
        $mapped = [];
        foreach ($broadcast['players'] ?? [] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $externalId = trim((string) ($row['external_id'] ?? ''));
            if ($externalId === '' || !isset($externalToLocalPlayer[$externalId])) {
                continue;
            }
            $mapped[(int) $externalToLocalPlayer[$externalId]] = $row;
        }

        if ($mapped === []) {
            return false;
        }

        $matches = $this->table('matches');
        $stmt = $this->db->prepare("SELECT player_a_id, player_b_id FROM `{$matches}` WHERE id=? LIMIT 1");
        $stmt->bind_param('i', $matchId);
        $stmt->execute();
        $match = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if (!$match) {
            return false;
        }

        $playerAId = (int) $match['player_a_id'];
        $playerBId = (int) $match['player_b_id'];
        $a = $mapped[$playerAId] ?? [];
        $b = $mapped[$playerBId] ?? [];

        $hasLiveScore = $this->hasAny($a, ['score', 'legs']) || $this->hasAny($b, ['score', 'legs']);
        $hasStats = false;
        foreach ($mapped as $playerId => $row) {
            if ($this->projectStatistics($matchId, (int) $playerId, $row)) {
                $hasStats = true;
            }
        }

        if ($hasLiveScore) {
            $this->projectLiveState($matchId, $a, $b);
            $stmt = $this->db->prepare(
                "UPDATE `{$matches}` SET status=IF(status IN ('pending','assigned'), 'in_progress', status) WHERE id=?"
            );
            $stmt->bind_param('i', $matchId);
            $stmt->execute();
            $stmt->close();
        }

        return $hasLiveScore || $hasStats;
    }

    private function projectLiveState(int $matchId, array $a, array $b): void
    {
        $table = $this->table('live_match_states');
        $aScore = $this->nullableInt($a['score'] ?? null);
        $bScore = $this->nullableInt($b['score'] ?? null);
        $aLegs = $this->nullableInt($a['legs'] ?? null);
        $bLegs = $this->nullableInt($b['legs'] ?? null);
        $status = 'observed';
        $metadata = $this->json([
            'source' => 'dartsatlas',
            'player_a' => $this->compactPlayerPayload($a),
            'player_b' => $this->compactPlayerPayload($b),
        ]);

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_a_score, player_b_score, player_a_legs, player_b_legs,
                 provider_status, provider_updated_at, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                player_a_score=COALESCE(VALUES(player_a_score), player_a_score),
                player_b_score=COALESCE(VALUES(player_b_score), player_b_score),
                player_a_legs=COALESCE(VALUES(player_a_legs), player_a_legs),
                player_b_legs=COALESCE(VALUES(player_b_legs), player_b_legs),
                provider_status=VALUES(provider_status), provider_updated_at=NOW(),
                provider_metadata=VALUES(provider_metadata)"
        );
        $stmt->bind_param('iiiiiss', $matchId, $aScore, $bScore, $aLegs, $bLegs, $status, $metadata);
        $stmt->execute();
        $stmt->close();
    }

    private function projectStatistics(int $matchId, int $playerId, array $row): bool
    {
        $fields = [
            'legs', 'average', 'first_nine_average', 'darts_thrown', 'checkout_hits',
            'checkout_attempts', 'highest_checkout', 'score_100_plus', 'score_140_plus', 'score_180',
        ];
        if (!$this->hasAny($row, $fields)) {
            return false;
        }

        $table = $this->table('match_statistics');
        $legsWon = $this->nullableInt($row['legs'] ?? null);
        $average = $this->nullableFloat($row['average'] ?? null);
        $firstNine = $this->nullableFloat($row['first_nine_average'] ?? null);
        $dartsThrown = $this->nullableInt($row['darts_thrown'] ?? null);
        $checkoutHits = $this->nullableInt($row['checkout_hits'] ?? null);
        $checkoutAttempts = $this->nullableInt($row['checkout_attempts'] ?? null);
        $highestCheckout = $this->nullableInt($row['highest_checkout'] ?? null);
        $score100 = $this->nullableInt($row['score_100_plus'] ?? null);
        $score140 = $this->nullableInt($row['score_140_plus'] ?? null);
        $score180 = $this->nullableInt($row['score_180'] ?? null);
        $metadata = $this->json(['source' => 'dartsatlas', 'external_id' => $row['external_id'] ?? null]);

        $stmt = $this->db->prepare(
            "INSERT INTO `{$table}`
                (match_id, player_id, legs_won, average, first_nine_average, darts_thrown,
                 checkout_hits, checkout_attempts, highest_checkout, score_100_plus, score_140_plus,
                 score_180, provider_metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                legs_won=COALESCE(VALUES(legs_won), legs_won),
                average=COALESCE(VALUES(average), average),
                first_nine_average=COALESCE(VALUES(first_nine_average), first_nine_average),
                darts_thrown=COALESCE(VALUES(darts_thrown), darts_thrown),
                checkout_hits=COALESCE(VALUES(checkout_hits), checkout_hits),
                checkout_attempts=COALESCE(VALUES(checkout_attempts), checkout_attempts),
                highest_checkout=COALESCE(VALUES(highest_checkout), highest_checkout),
                score_100_plus=COALESCE(VALUES(score_100_plus), score_100_plus),
                score_140_plus=COALESCE(VALUES(score_140_plus), score_140_plus),
                score_180=COALESCE(VALUES(score_180), score_180),
                provider_metadata=VALUES(provider_metadata)"
        );
        $stmt->bind_param(
            'iiiddi' . 'iiiiiis',
            $matchId,
            $playerId,
            $legsWon,
            $average,
            $firstNine,
            $dartsThrown,
            $checkoutHits,
            $checkoutAttempts,
            $highestCheckout,
            $score100,
            $score140,
            $score180,
            $metadata,
        );
        $stmt->execute();
        $stmt->close();
        return true;
    }

    private function compactPlayerPayload(array $row): array
    {
        return array_intersect_key($row, array_flip([
            'external_id', 'name', 'score', 'legs', 'average', 'first_nine_average',
            'darts_thrown', 'checkout_hits', 'checkout_attempts', 'highest_checkout',
            'score_100_plus', 'score_140_plus', 'score_180',
        ]));
    }

    private function hasAny(array $row, array $keys): bool
    {
        foreach ($keys as $key) {
            if (array_key_exists($key, $row) && $row[$key] !== null && $row[$key] !== '') {
                return true;
            }
        }
        return false;
    }

    private function nullableInt(mixed $value): ?int
    {
        return is_int($value) || (is_string($value) && preg_match('/^-?\d+$/', $value)) ? (int) $value : null;
    }

    private function nullableFloat(mixed $value): ?float
    {
        return is_int($value) || is_float($value) || (is_string($value) && is_numeric(str_replace(',', '.', $value)))
            ? (float) str_replace(',', '.', (string) $value)
            : null;
    }

    private function table(string $name): string
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $name)) {
            throw new InvalidArgumentException('Unsafe table name.');
        }
        return $this->prefix . $name;
    }

    private function json(array $payload): string
    {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
