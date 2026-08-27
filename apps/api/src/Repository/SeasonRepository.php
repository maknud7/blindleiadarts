<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use InvalidArgumentException;
use mysqli;

final class SeasonRepository
{
    private mysqli $connection;
    private string $prefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
    }

    /** @return list<array<string,mixed>> */
    public function listByClub(int $clubId): array
    {
        $sql = sprintf(
            'SELECT s.id,s.club_id,s.name,s.starts_on,s.ends_on,s.is_active,s.status,s.ranking_method,
                    s.points_win,s.points_draw,s.points_loss,s.champion_player_id,s.completed_at,
                    p.display_name AS champion_name,
                    COUNT(DISTINCT t.id) AS tournament_count,
                    COUNT(DISTINCT CASE WHEN t.status="completed" THEN t.id END) AS completed_tournament_count
             FROM `%1$sseasons` s
             LEFT JOIN `%1$splayers` p ON p.id=s.champion_player_id
             LEFT JOIN `%1$stournaments` t ON t.season_id=s.id
             WHERE s.club_id=?
             GROUP BY s.id,s.club_id,s.name,s.starts_on,s.ends_on,s.is_active,s.status,s.ranking_method,
                      s.points_win,s.points_draw,s.points_loss,s.champion_player_id,s.completed_at,p.display_name
             ORDER BY s.is_active DESC, COALESCE(s.starts_on,"0000-01-01") DESC, s.id DESC',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return array_map([$this, 'formatSeason'], $rows);
    }

    /** @return array<string,mixed>|null */
    public function find(int $seasonId): ?array
    {
        $sql = sprintf(
            'SELECT s.*, p.display_name AS champion_name,
                    (SELECT COUNT(*) FROM `%1$stournaments` t WHERE t.season_id=s.id) AS tournament_count,
                    (SELECT COUNT(*) FROM `%1$stournaments` t WHERE t.season_id=s.id AND t.status="completed") AS completed_tournament_count
             FROM `%1$sseasons` s
             LEFT JOIN `%1$splayers` p ON p.id=s.champion_player_id
             WHERE s.id=? LIMIT 1',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $seasonId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row === null ? null : $this->formatSeason($row);
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function create(int $clubId, array $payload): array
    {
        $name = trim((string) ($payload['name'] ?? ''));
        if ($name === '') {
            throw new InvalidArgumentException('Sesongen må ha et navn.');
        }
        $starts = $this->dateOrNull($payload['starts_on'] ?? null);
        $ends = $this->dateOrNull($payload['ends_on'] ?? null);
        if ($starts !== null && $ends !== null && $ends < $starts) {
            throw new InvalidArgumentException('Sluttdato kan ikke være før startdato.');
        }
        $ranking = $this->rankingMethod($payload['ranking_method'] ?? 'match_points');
        $win = $this->points($payload['points_win'] ?? 2);
        $draw = $this->points($payload['points_draw'] ?? 1);
        $loss = $this->points($payload['points_loss'] ?? 0);
        $status = 'draft';
        $active = 0;

        $sql = sprintf(
            'INSERT INTO `%1$sseasons`
             (club_id,name,starts_on,ends_on,is_active,status,ranking_method,points_win,points_draw,points_loss)
             VALUES (?,?,?,?,?,?,?,?,?,?)',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isssissddd', $clubId, $name, $starts, $ends, $active, $status, $ranking, $win, $draw, $loss);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();

        if (($payload['activate'] ?? false) === true) {
            return $this->activate($id);
        }
        return $this->find($id) ?? [];
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function update(int $seasonId, array $payload): array
    {
        $current = $this->find($seasonId);
        if ($current === null) {
            throw new ValidationException('season_not_found', 'Sesongen ble ikke funnet.', 404);
        }
        if ((string) $current['status'] === 'completed') {
            throw new ValidationException('season_completed', 'En avsluttet sesong er låst.', 409);
        }

        $name = array_key_exists('name', $payload) ? trim((string) $payload['name']) : (string) $current['name'];
        if ($name === '') throw new InvalidArgumentException('Sesongen må ha et navn.');
        $starts = array_key_exists('starts_on', $payload) ? $this->dateOrNull($payload['starts_on']) : $current['starts_on'];
        $ends = array_key_exists('ends_on', $payload) ? $this->dateOrNull($payload['ends_on']) : $current['ends_on'];
        if ($starts !== null && $ends !== null && $ends < $starts) throw new InvalidArgumentException('Sluttdato kan ikke være før startdato.');
        $ranking = $this->rankingMethod($payload['ranking_method'] ?? $current['ranking_method']);
        $win = $this->points($payload['points_win'] ?? $current['points_win']);
        $draw = $this->points($payload['points_draw'] ?? $current['points_draw']);
        $loss = $this->points($payload['points_loss'] ?? $current['points_loss']);

        $sql = sprintf('UPDATE `%1$sseasons` SET name=?,starts_on=?,ends_on=?,ranking_method=?,points_win=?,points_draw=?,points_loss=? WHERE id=?', $this->prefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssssdddi', $name, $starts, $ends, $ranking, $win, $draw, $loss, $seasonId);
        $stmt->execute();
        $stmt->close();
        return $this->find($seasonId) ?? [];
    }

    /** @return array<string,mixed> */
    public function activate(int $seasonId): array
    {
        $season = $this->find($seasonId);
        if ($season === null) throw new ValidationException('season_not_found', 'Sesongen ble ikke funnet.', 404);
        if ((string) $season['status'] === 'completed') throw new ValidationException('season_completed', 'En avsluttet sesong kan ikke aktiveres igjen.', 409);
        $clubId = (int) $season['club_id'];

        $this->connection->begin_transaction();
        try {
            $stmt = $this->connection->prepare(sprintf('UPDATE `%1$sseasons` SET is_active=0,status=IF(status="active","draft",status) WHERE club_id=? AND id<>?', $this->prefix));
            $stmt->bind_param('ii', $clubId, $seasonId);
            $stmt->execute();
            $stmt->close();
            $stmt = $this->connection->prepare(sprintf('UPDATE `%1$sseasons` SET is_active=1,status="active" WHERE id=?', $this->prefix));
            $stmt->bind_param('i', $seasonId);
            $stmt->execute();
            $stmt->close();
            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }
        return $this->find($seasonId) ?? [];
    }

    /** @return list<array<string,mixed>> */
    public function standings(int $seasonId): array
    {
        $season = $this->find($seasonId);
        if ($season === null) throw new ValidationException('season_not_found', 'Sesongen ble ikke funnet.', 404);

        $sql = sprintf(
            'SELECT p.id,p.display_name,p.nickname,
                    COUNT(DISTINCT t.id) AS tournaments,
                    COUNT(DISTINCT m.id) AS matches_played,
                    COUNT(DISTINCT CASE WHEN m.winner_player_id=p.id THEN m.id END) AS wins,
                    COUNT(DISTINCT CASE WHEN m.id IS NOT NULL AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                    COUNT(DISTINCT CASE WHEN m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                    (SELECT COUNT(*) FROM `%1$slegs` lw INNER JOIN `%1$smatches` mw ON mw.id=lw.match_id INNER JOIN `%1$stournaments` tw ON tw.id=mw.tournament_id WHERE tw.season_id=? AND lw.status="completed" AND lw.winner_player_id=p.id) AS legs_won,
                    (SELECT COUNT(*) FROM `%1$slegs` ll INNER JOIN `%1$smatches` ml ON ml.id=ll.match_id INNER JOIN `%1$stournaments` tl ON tl.id=ml.tournament_id WHERE tl.season_id=? AND ll.status="completed" AND ll.winner_player_id IS NOT NULL AND ll.winner_player_id<>p.id AND (ml.player_a_id=p.id OR ml.player_b_id=p.id)) AS legs_lost,
                    COALESCE((SELECT ROUND(COALESCE(
                        SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                        AVG(ms.average)
                    ),2)
                        FROM `%1$smatch_statistics` ms
                        INNER JOIN `%1$smatches` sm ON sm.id=ms.match_id
                        INNER JOIN `%1$stournaments` st ON st.id=sm.tournament_id
                        WHERE st.season_id=? AND sm.status="completed" AND ms.player_id=p.id AND ms.average IS NOT NULL),0) AS three_dart_average,
                    e.rating AS elo_rating,e.matches_played AS elo_matches_played
             FROM `%1$splayers` p
             INNER JOIN `%1$stournament_players` tp ON tp.player_id=p.id AND tp.status<>"withdrawn"
             INNER JOIN `%1$stournaments` t ON t.id=tp.tournament_id AND t.season_id=?
             LEFT JOIN `%1$smatches` m ON m.tournament_id=t.id AND m.status="completed" AND (m.player_a_id=p.id OR m.player_b_id=p.id)
             LEFT JOIN `%1$selo_current_ratings` e ON e.player_id=p.id AND e.season_id=?
             GROUP BY p.id,p.display_name,p.nickname,e.rating,e.matches_played',
            $this->prefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiiii', $seasonId, $seasonId, $seasonId, $seasonId, $seasonId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $winPoints = (float) $season['points_win'];
        $drawPoints = (float) $season['points_draw'];
        $lossPoints = (float) $season['points_loss'];
        $method = (string) $season['ranking_method'];
        $linearPoints = $method === 'linear' ? $this->linearPoints($seasonId) : [];
        foreach ($rows as &$row) {
            foreach (['tournaments','matches_played','wins','draws','losses','legs_won','legs_lost','elo_matches_played'] as $field) {
                $row[$field] = (int) ($row[$field] ?? 0);
            }
            $row['leg_diff'] = $row['legs_won'] - $row['legs_lost'];
            $row['three_dart_average'] = round((float) ($row['three_dart_average'] ?? 0), 2);
            $row['points'] = $method === 'linear'
                ? round((float) ($linearPoints[(int) $row['id']] ?? 0), 2)
                : round(($row['wins'] * $winPoints) + ($row['draws'] * $drawPoints) + ($row['losses'] * $lossPoints), 2);
            $row['elo_rating'] = $row['elo_rating'] !== null ? (float) $row['elo_rating'] : 1000.0;
            $row['head_to_head_points'] = 0;
        }
        unset($row);

        $rows = $this->sortStandingsWithTieBreak($rows, $seasonId, $method);
        foreach ($rows as $index => &$row) $row['position'] = $index + 1;
        unset($row);
        return $rows;
    }

    /** @return array<string,mixed> */
    public function complete(int $seasonId): array
    {
        $season = $this->find($seasonId);
        if ($season === null) throw new ValidationException('season_not_found', 'Sesongen ble ikke funnet.', 404);
        if ((string) $season['status'] === 'completed') return $season;
        $standings = $this->standings($seasonId);
        if ($standings === []) throw new ValidationException('season_has_no_results', 'Sesongen har ingen resultater å kåre vinner fra.', 409);
        $championId = (int) $standings[0]['id'];
        $stmt = $this->connection->prepare(sprintf('UPDATE `%1$sseasons` SET champion_player_id=?,status="completed",is_active=0,completed_at=NOW() WHERE id=?', $this->prefix));
        $stmt->bind_param('ii', $championId, $seasonId);
        $stmt->execute();
        $stmt->close();
        return $this->find($seasonId) ?? [];
    }

    /** @param list<array<string,mixed>> $rows @return list<array<string,mixed>> */
    private function sortStandingsWithTieBreak(array $rows, int $seasonId, string $method): array
    {
        $primary = static fn (array $row): float => $method === 'elo' ? (float) $row['elo_rating'] : (float) $row['points'];
        usort($rows, static function (array $a, array $b) use ($primary): int {
            $cmp = $primary($b) <=> $primary($a);
            if ($cmp !== 0) return $cmp;
            $cmp = ((int) $b['leg_diff']) <=> ((int) $a['leg_diff']);
            if ($cmp !== 0) return $cmp;
            $cmp = ((float) $b['three_dart_average']) <=> ((float) $a['three_dart_average']);
            return $cmp !== 0 ? $cmp : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });

        $ranked = [];
        for ($index = 0, $count = count($rows); $index < $count;) {
            $bucket = [$rows[$index]];
            $cursor = $index + 1;
            while ($cursor < $count
                && abs($primary($rows[$cursor]) - $primary($rows[$index])) < 0.0001
                && (int) $rows[$cursor]['leg_diff'] === (int) $rows[$index]['leg_diff']
                && abs((float) $rows[$cursor]['three_dart_average'] - (float) $rows[$index]['three_dart_average']) < 0.0001) {
                $bucket[] = $rows[$cursor];
                $cursor++;
            }

            if (count($bucket) > 1) {
                $points = $this->seasonHeadToHeadPoints(
                    $seasonId,
                    array_map(static fn (array $row): int => (int) $row['id'], $bucket)
                );
                foreach ($bucket as &$row) {
                    $row['head_to_head_points'] = (int) ($points[(int) $row['id']] ?? 0);
                }
                unset($row);
                usort($bucket, static function (array $a, array $b): int {
                    $cmp = ((int) $b['head_to_head_points']) <=> ((int) $a['head_to_head_points']);
                    return $cmp !== 0 ? $cmp : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
                });
            }

            array_push($ranked, ...$bucket);
            $index = $cursor;
        }
        return $ranked;
    }

    /** @param list<int> $playerIds @return array<int,int> */
    private function seasonHeadToHeadPoints(int $seasonId, array $playerIds): array
    {
        $playerIds = array_values(array_unique(array_filter(array_map('intval', $playerIds), static fn (int $id): bool => $id > 0)));
        if (count($playerIds) < 2) return [];
        $ids = implode(',', $playerIds);
        $sql = sprintf(
            'SELECT m.player_a_id,m.player_b_id,m.winner_player_id
             FROM `%1$smatches` m
             INNER JOIN `%1$stournaments` t ON t.id=m.tournament_id
             WHERE t.season_id=%2$d AND m.status="completed"
               AND m.player_a_id IN (%3$s) AND m.player_b_id IN (%3$s)',
            $this->prefix,
            $seasonId,
            $ids
        );
        $matches = $this->connection->query($sql)->fetch_all(MYSQLI_ASSOC);
        $points = array_fill_keys($playerIds, 0);
        foreach ($matches as $match) {
            $a = (int) $match['player_a_id'];
            $b = (int) $match['player_b_id'];
            if ($match['winner_player_id'] === null) {
                $points[$a] = ($points[$a] ?? 0) + 1;
                $points[$b] = ($points[$b] ?? 0) + 1;
            } else {
                $winner = (int) $match['winner_player_id'];
                $points[$winner] = ($points[$winner] ?? 0) + 2;
            }
        }
        return $points;
    }

    /** @return array<int,float> */
    private function linearPoints(int $seasonId): array
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT player_id,SUM(points) AS points
             FROM `%1$sseason_ranking_events`
             WHERE season_id=? AND ruleset="linear_v1" AND status="applied"
             GROUP BY player_id',
            $this->prefix
        ));
        $stmt->bind_param('i', $seasonId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        $result = [];
        foreach ($rows as $row) {
            $result[(int) $row['player_id']] = (float) $row['points'];
        }
        return $result;
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private function formatSeason(array $row): array
    {
        foreach (['id','club_id','champion_player_id','tournament_count','completed_tournament_count'] as $field) {
            if (array_key_exists($field, $row) && $row[$field] !== null) $row[$field] = (int) $row[$field];
        }
        $row['is_active'] = (int) ($row['is_active'] ?? 0) === 1;
        foreach (['points_win','points_draw','points_loss'] as $field) $row[$field] = (float) ($row[$field] ?? 0);
        return $row;
    }

    private function rankingMethod(mixed $value): string
    {
        $value = trim((string) $value);
        if (!in_array($value, ['match_points','linear','elo'], true)) throw new InvalidArgumentException('Ugyldig metode for sesongtabellen.');
        return $value;
    }

    private function points(mixed $value): float
    {
        if (!is_numeric($value)) throw new InvalidArgumentException('Sesongpoeng må være et tall.');
        $points = (float) $value;
        if ($points < 0 || $points > 1000) throw new InvalidArgumentException('Sesongpoeng må være mellom 0 og 1000.');
        return $points;
    }

    private function dateOrNull(mixed $value): ?string
    {
        $value = trim((string) ($value ?? ''));
        if ($value === '') return null;
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        if (!$date || $date->format('Y-m-d') !== $value) throw new InvalidArgumentException('Dato må være på formatet ÅÅÅÅ-MM-DD.');
        return $value;
    }
}
