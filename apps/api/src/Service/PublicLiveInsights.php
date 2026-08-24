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

    /** @return array<string, mixed>|null */
    private function mondayEloSnapshot(): ?array
    {
        $path = dirname(__DIR__, 2) . '/data/mandagsserien-elo-2026-08-24.php';
        if (!is_file($path)) {
            return null;
        }

        $snapshot = require $path;
        return is_array($snapshot) ? $snapshot : null;
    }

    private function playerKey(string $name): string
    {
        $name = preg_replace('/\s+/u', ' ', trim($name)) ?? trim($name);
        return mb_strtolower($name, 'UTF-8');
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
     * Calculates Mandagsserien ELO with the same model as the Monday summaries.
     *
     * If an authoritative snapshot exists, it is used as the starting state and
     * only matches from tournaments scheduled on/after the snapshot date are
     * applied. This prevents historical matches from being counted twice while
     * preserving the exact published rating and match count as the baseline.
     *
     * @return array<string, mixed>
     */
    public function liveElo(int $tournamentId, ?int $seasonId, int $limit = 20): array
    {
        $baseline = 1000.0;
        $divisor = 400.0;
        $ratings = [];
        $names = [];
        $playerIds = [];
        $played = [];
        $wins = [];
        $losses = [];
        $changes = [];

        $snapshot = $this->mondayEloSnapshot();
        $snapshotDate = null;
        $snapshotAsOf = null;
        $usingSnapshot = is_array($snapshot) && is_array($snapshot['players'] ?? null);

        if ($usingSnapshot) {
            $snapshotDate = trim((string) ($snapshot['effective_from_date'] ?? '')) ?: null;
            $snapshotAsOf = trim((string) ($snapshot['as_of'] ?? '')) ?: null;
            foreach ($snapshot['players'] as $row) {
                if (!is_array($row)) {
                    continue;
                }
                $name = trim((string) ($row['display_name'] ?? ''));
                if ($name === '') {
                    continue;
                }
                $key = $this->playerKey($name);
                $ratings[$key] = (float) ($row['rating'] ?? $baseline);
                $names[$key] = $name;
                $playerIds[$key] = null;
                $played[$key] = max(0, (int) ($row['played'] ?? 0));
                // The supplied snapshot contains rating + match count, not W/L.
                // Keep the record unknown rather than displaying a false 0-0.
                $wins[$key] = null;
                $losses[$key] = null;
            }
        } elseif ($tournamentId > 0) {
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
                $name = (string) $row['display_name'];
                $key = $this->playerKey($name);
                $ratings[$key] = $baseline;
                $names[$key] = $name;
                $playerIds[$key] = (int) $row['id'];
                $played[$key] = 0;
                $wins[$key] = 0;
                $losses[$key] = 0;
            }
            $participants->close();
        }

        $scopeSql = $seasonId !== null ? 't.season_id = ?' : 't.id = ?';
        $scopeId = $seasonId ?? $tournamentId;
        $dateFilter = $usingSnapshot && $snapshotDate !== null
            ? ' AND t.start_at IS NOT NULL AND DATE(t.start_at) >= ?'
            : '';

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
                t.start_at AS tournament_at,
                COALESCE(m.finished_at, m.updated_at, m.created_at) AS completed_at
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id = m.tournament_id
             INNER JOIN `%1$splayers` pa ON pa.id = m.player_a_id
             INNER JOIN `%1$splayers` pb ON pb.id = m.player_b_id
             WHERE %2$s
               AND t.provider_system = "dartsatlas"
               AND m.status = "completed"
               AND m.winner_player_id IS NOT NULL%3$s
             ORDER BY t.start_at ASC, t.id ASC, completed_at ASC, m.id ASC',
            $this->prefix,
            $scopeSql,
            $dateFilter
        );

        $statement = $this->db->prepare($matchesSql);
        if ($usingSnapshot && $snapshotDate !== null) {
            $statement->bind_param('is', $scopeId, $snapshotDate);
        } else {
            $statement->bind_param('i', $scopeId);
        }
        $statement->execute();
        $matches = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        foreach ($matches as $match) {
            $playerAId = (int) $match['player_a_id'];
            $playerBId = (int) $match['player_b_id'];
            $winner = (int) $match['winner_player_id'];
            $playerAName = (string) $match['player_a_name'];
            $playerBName = (string) $match['player_b_name'];
            $playerA = $this->playerKey($playerAName);
            $playerB = $this->playerKey($playerBName);

            foreach ([[$playerA, $playerAId, $playerAName], [$playerB, $playerBId, $playerBName]] as [$key, $id, $name]) {
                if (!array_key_exists($key, $ratings)) {
                    $ratings[$key] = $baseline;
                    $names[$key] = $name;
                    $played[$key] = 0;
                    $wins[$key] = 0;
                    $losses[$key] = 0;
                }
                $playerIds[$key] = $id;
            }

            $beforeA = (float) $ratings[$playerA];
            $beforeB = (float) $ratings[$playerB];
            $preMatchCountA = (int) $played[$playerA];
            $preMatchCountB = (int) $played[$playerB];
            $kA = $preMatchCountA <= 10 ? 25.0 : 15.0;
            $kB = $preMatchCountB <= 10 ? 25.0 : 15.0;

            $expectedA = 1.0 / (1.0 + pow(10.0, ($beforeB - $beforeA) / $divisor));
            $expectedB = 1.0 / (1.0 + pow(10.0, ($beforeA - $beforeB) / $divisor));
            $scoreA = $winner === $playerAId ? 1.0 : 0.0;
            $scoreB = $winner === $playerBId ? 1.0 : 0.0;
            $deltaA = $kA * ($scoreA - $expectedA);
            $deltaB = $kB * ($scoreB - $expectedB);

            $ratings[$playerA] = $beforeA + $deltaA;
            $ratings[$playerB] = $beforeB + $deltaB;
            $played[$playerA]++;
            $played[$playerB]++;

            if ($wins[$playerA] !== null && $losses[$playerA] !== null
                && $wins[$playerB] !== null && $losses[$playerB] !== null) {
                if ($winner === $playerAId) {
                    $wins[$playerA]++;
                    $losses[$playerB]++;
                } else {
                    $wins[$playerB]++;
                    $losses[$playerA]++;
                }
            }

            if ($tournamentId > 0 && (int) $match['tournament_id'] === $tournamentId) {
                $changes[] = [
                    'match_id' => (int) $match['id'],
                    'round_label' => (string) $match['round_label'],
                    'completed_at' => $match['completed_at'],
                    'winner_player_id' => $winner,
                    'player_a' => [
                        'id' => $playerAId,
                        'display_name' => $names[$playerA],
                        'before' => round($beforeA, 1),
                        'after' => round((float) $ratings[$playerA], 1),
                        'delta' => round($deltaA, 1),
                        'k_factor' => (int) $kA,
                        'pre_match_count' => $preMatchCountA,
                    ],
                    'player_b' => [
                        'id' => $playerBId,
                        'display_name' => $names[$playerB],
                        'before' => round($beforeB, 1),
                        'after' => round((float) $ratings[$playerB], 1),
                        'delta' => round($deltaB, 1),
                        'k_factor' => (int) $kB,
                        'pre_match_count' => $preMatchCountB,
                    ],
                ];
            }
        }

        $table = [];
        foreach ($ratings as $key => $rating) {
            $table[] = [
                'player_id' => $playerIds[$key] ?? null,
                'display_name' => $names[$key] ?? 'Spiller',
                'rating' => round((float) $rating, 1),
                'rating_sort' => (float) $rating,
                'played' => (int) ($played[$key] ?? 0),
                'wins' => $wins[$key] ?? null,
                'losses' => $losses[$key] ?? null,
                'next_k_factor' => ((int) ($played[$key] ?? 0)) <= 10 ? 25 : 15,
            ];
        }

        usort($table, static function (array $a, array $b): int {
            if (abs((float) $a['rating_sort'] - (float) $b['rating_sort']) > 0.0000001) {
                return (float) $b['rating_sort'] <=> (float) $a['rating_sort'];
            }
            if ((int) $a['played'] !== (int) $b['played']) {
                return (int) $b['played'] <=> (int) $a['played'];
            }
            return strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });

        foreach ($table as $index => &$row) {
            $row['position'] = $index + 1;
            unset($row['rating_sort']);
        }
        unset($row);

        return [
            'baseline' => $baseline,
            'divisor' => (int) $divisor,
            'source' => $usingSnapshot ? 'authoritative_snapshot_plus_live' : 'season_replay',
            'snapshot_as_of' => $snapshotAsOf,
            'k_factor_model' => [
                'pre_match_count_10_or_less' => 25,
                'pre_match_count_above_10' => 15,
            ],
            'table' => array_slice($table, 0, max(1, $limit)),
            'changes' => array_slice(array_reverse($changes), 0, 8),
        ];
    }
}
