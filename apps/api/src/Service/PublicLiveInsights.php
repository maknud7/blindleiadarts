<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class PublicLiveInsights
{
    private mysqli $db;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->db = $database->connection();
        $this->prefix = $database->tablePrefix();
    }

    /**
     * DartsAtlas currently exposes exact 180 counts, but only bucketed 140+ and 100+ counts.
     * Do not fabricate exact visit scores such as 177/171 when the provider did not send them.
     *
     * @return array<int, array<string, mixed>>
     */
    public function topVisitBuckets(int $tournamentId, int $limit = 5): array
    {
        $sql = sprintf(
            'SELECT
                m.id AS match_id,
                COALESCE(m.round_label, m.bracket_label, "Kamp") AS round_label,
                p.id AS player_id,
                p.display_name,
                COALESCE(ms.score_180, 0) AS score_180,
                COALESCE(ms.score_140_plus, 0) AS score_140_plus,
                COALESCE(ms.score_100_plus, 0) AS score_100_plus
             FROM `%1$smatch_statistics` ms
             INNER JOIN `%1$smatches` m ON m.id = ms.match_id
             INNER JOIN `%1$splayers` p ON p.id = ms.player_id
             WHERE m.tournament_id = ?
               AND (COALESCE(ms.score_180, 0) > 0
                    OR COALESCE(ms.score_140_plus, 0) > 0
                    OR COALESCE(ms.score_100_plus, 0) > 0)',
            $this->prefix
        );

        $statement = $this->db->prepare($sql);
        $statement->bind_param('i', $tournamentId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        $items = [];
        foreach ($rows as $row) {
            foreach ([
                ['field' => 'score_180', 'label' => '180', 'rank' => 3],
                ['field' => 'score_140_plus', 'label' => '140+', 'rank' => 2],
                ['field' => 'score_100_plus', 'label' => '100+', 'rank' => 1],
            ] as $bucket) {
                $count = (int) ($row[$bucket['field']] ?? 0);
                if ($count <= 0) {
                    continue;
                }
                $items[] = [
                    'label' => $bucket['label'],
                    'bucket_rank' => $bucket['rank'],
                    'count' => $count,
                    'player_id' => (int) $row['player_id'],
                    'display_name' => (string) $row['display_name'],
                    'match_id' => (int) $row['match_id'],
                    'round_label' => (string) $row['round_label'],
                ];
            }
        }

        usort($items, static function (array $a, array $b): int {
            if ($a['bucket_rank'] !== $b['bucket_rank']) {
                return $b['bucket_rank'] <=> $a['bucket_rank'];
            }
            if ($a['count'] !== $b['count']) {
                return $b['count'] <=> $a['count'];
            }
            return $b['match_id'] <=> $a['match_id'];
        });

        foreach ($items as &$item) {
            unset($item['bucket_rank']);
        }
        unset($item);

        return array_slice($items, 0, max(1, $limit));
    }

    /**
     * Replays the season ELO exactly like the Monday summaries:
     * - every player starts the season at 1000
     * - standard Elo expected score with a 400-point divisor
     * - K=25 when that player's pre-match count is 10 or lower
     * - K=15 when that player's pre-match count is above 10
     * - ratings retain full precision between matches and are rounded only for display
     * - all completed DartsAtlas matches in the season are processed chronologically
     *
     * The calculation is intentionally non-persisted and never overwrites canonical ranking snapshots.
     *
     * @return array<string, mixed>
     */
    public function liveElo(int $tournamentId, ?int $seasonId, int $limit = 20): array
    {
        $baseline = 1000.0;
        $divisor = 400.0;
        $ratings = [];
        $names = [];
        $played = [];
        $wins = [];
        $losses = [];
        $changes = [];

        $participantsSql = sprintf(
            'SELECT p.id, p.display_name
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id = tp.player_id
             WHERE tp.tournament_id = ? AND tp.status <> "withdrawn"
             ORDER BY p.display_name ASC',
            $this->prefix
        );
        $participants = $this->db->prepare($participantsSql);
        $participants->bind_param('i', $tournamentId);
        $participants->execute();
        foreach ($participants->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
            $id = (int) $row['id'];
            $ratings[$id] = $baseline;
            $names[$id] = (string) $row['display_name'];
            $played[$id] = 0;
            $wins[$id] = 0;
            $losses[$id] = 0;
        }
        $participants->close();

        $scopeSql = $seasonId !== null
            ? 't.season_id = ?'
            : 't.id = ?';
        $scopeId = $seasonId ?? $tournamentId;
        $matchesSql = sprintf(
            'SELECT
                m.id,
                m.tournament_id,
                t.name AS tournament_name,
                COALESCE(m.round_label, m.bracket_label, "Kamp") AS round_label,
                m.player_a_id,
                pa.display_name AS player_a_name,
                m.player_b_id,
                pb.display_name AS player_b_name,
                m.winner_player_id,
                COALESCE(t.start_at, t.created_at) AS tournament_at,
                COALESCE(m.finished_at, m.updated_at, m.created_at) AS completed_at
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             WHERE %2$s
               AND t.provider_system = "dartsatlas"
               AND m.status = "completed"
               AND m.winner_player_id IS NOT NULL
             ORDER BY tournament_at ASC, t.id ASC, completed_at ASC, m.id ASC',
            $this->prefix,
            $scopeSql
        );
        $statement = $this->db->prepare($matchesSql);
        $statement->bind_param('i', $scopeId);
        $statement->execute();
        $matches = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        foreach ($matches as $match) {
            $playerA = (int) $match['player_a_id'];
            $playerB = (int) $match['player_b_id'];
            $winner = (int) $match['winner_player_id'];

            foreach ([[$playerA, (string) $match['player_a_name']], [$playerB, (string) $match['player_b_name']]] as [$id, $name]) {
                if (!isset($ratings[$id])) {
                    $ratings[$id] = $baseline;
                    $names[$id] = $name;
                    $played[$id] = 0;
                    $wins[$id] = 0;
                    $losses[$id] = 0;
                }
            }

            $beforeA = (float) $ratings[$playerA];
            $beforeB = (float) $ratings[$playerB];
            $preMatchCountA = (int) $played[$playerA];
            $preMatchCountB = (int) $played[$playerB];
            $kA = $preMatchCountA <= 10 ? 25.0 : 15.0;
            $kB = $preMatchCountB <= 10 ? 25.0 : 15.0;

            $expectedA = 1.0 / (1.0 + pow(10.0, ($beforeB - $beforeA) / $divisor));
            $expectedB = 1.0 / (1.0 + pow(10.0, ($beforeA - $beforeB) / $divisor));
            $scoreA = $winner === $playerA ? 1.0 : 0.0;
            $scoreB = $winner === $playerB ? 1.0 : 0.0;
            $deltaA = $kA * ($scoreA - $expectedA);
            $deltaB = $kB * ($scoreB - $expectedB);

            $ratings[$playerA] = $beforeA + $deltaA;
            $ratings[$playerB] = $beforeB + $deltaB;
            $played[$playerA]++;
            $played[$playerB]++;
            if ($winner === $playerA) {
                $wins[$playerA]++;
                $losses[$playerB]++;
            } else {
                $wins[$playerB]++;
                $losses[$playerA]++;
            }

            if ((int) $match['tournament_id'] === $tournamentId) {
                $changes[] = [
                    'match_id' => (int) $match['id'],
                    'round_label' => (string) $match['round_label'],
                    'completed_at' => $match['completed_at'],
                    'winner_player_id' => $winner,
                    'player_a' => [
                        'id' => $playerA,
                        'display_name' => $names[$playerA],
                        'before' => $beforeA,
                        'after' => $ratings[$playerA],
                        'delta' => $deltaA,
                        'k_factor' => (int) $kA,
                        'pre_match_count' => $preMatchCountA,
                    ],
                    'player_b' => [
                        'id' => $playerB,
                        'display_name' => $names[$playerB],
                        'before' => $beforeB,
                        'after' => $ratings[$playerB],
                        'delta' => $deltaB,
                        'k_factor' => (int) $kB,
                        'pre_match_count' => $preMatchCountB,
                    ],
                ];
            }
        }

        $table = [];
        foreach ($ratings as $playerId => $rating) {
            $table[] = [
                'player_id' => (int) $playerId,
                'display_name' => $names[$playerId] ?? ('Spiller ' . $playerId),
                'rating' => (float) $rating,
                'played' => (int) ($played[$playerId] ?? 0),
                'wins' => (int) ($wins[$playerId] ?? 0),
                'losses' => (int) ($losses[$playerId] ?? 0),
                'next_k_factor' => ((int) ($played[$playerId] ?? 0)) <= 10 ? 25 : 15,
            ];
        }

        usort($table, static function (array $a, array $b): int {
            if (abs((float) $a['rating'] - (float) $b['rating']) > 0.0000001) {
                return (float) $b['rating'] <=> (float) $a['rating'];
            }
            if ($a['wins'] !== $b['wins']) {
                return $b['wins'] <=> $a['wins'];
            }
            if ($a['losses'] !== $b['losses']) {
                return $a['losses'] <=> $b['losses'];
            }
            return strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });
        foreach ($table as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);

        return [
            'baseline' => $baseline,
            'divisor' => (int) $divisor,
            'k_factor_model' => [
                'pre_match_count_10_or_less' => 25,
                'pre_match_count_above_10' => 15,
            ],
            'table' => array_slice($table, 0, max(1, $limit)),
            'changes' => array_slice(array_reverse($changes), 0, 8),
        ];
    }
}
