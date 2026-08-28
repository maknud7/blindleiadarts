<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api;

use Blindleia\Dartkiosk\Api\Http\JsonResponse;
use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use mysqli_sql_exception;
use Throwable;

final class LiveHighlightsApplication
{
    public function __construct(private readonly string $rootPath)
    {
    }

    public function run(): bool
    {
        $request = Request::fromGlobals();
        $path = trim($request->path(), '/');
        if ($request->method() !== 'GET' || preg_match('#^v1/tournaments/(\d+)/live-highlights$#', $path, $match) !== 1) {
            return false;
        }

        try {
            $config = Config::load($this->rootPath);
            $database = new Database($config);
            $payload = $this->build($database, (int) $match[1]);
            if ($payload['tournament'] === null) {
                $response = JsonResponse::error(404, 'tournament_not_found', 'Tournament was not found.');
            } else {
                $response = JsonResponse::ok($payload);
            }
        } catch (mysqli_sql_exception) {
            $response = JsonResponse::error(500, 'database_error', 'Database query failed.');
        } catch (Throwable) {
            $response = JsonResponse::error(500, 'internal_server_error', 'Unexpected server error.');
        }

        $response->send();
        return true;
    }

    /** @return array<string,mixed> */
    private function build(Database $database, int $tournamentId): array
    {
        $connection = $database->connection();
        $prefix = $database->tablePrefix();

        $check = $connection->prepare(sprintf('SELECT id,name,status FROM `%1$stournaments` WHERE id=? LIMIT 1', $prefix));
        $check->bind_param('i', $tournamentId);
        $check->execute();
        $tournament = $check->get_result()->fetch_assoc() ?: null;
        $check->close();

        if ($tournament === null) {
            return [
                'tournament' => null,
                'standings' => [],
                'top_visits' => [],
                'top_checkouts' => [],
                'top_three_dart_averages' => [],
                'tie_break_order' => ['points', 'leg_difference', 'three_dart_average'],
            ];
        }

        return [
            'tournament' => $tournament,
            'standings' => $this->standings($connection, $prefix, $tournamentId),
            'top_visits' => $this->topVisits($connection, $prefix, $tournamentId),
            'top_checkouts' => $this->topCheckouts($connection, $prefix, $tournamentId),
            'top_three_dart_averages' => $this->topThreeDartAverages($connection, $prefix, $tournamentId),
            'tie_break_order' => ['points', 'leg_difference', 'three_dart_average'],
        ];
    }

    /** @return array<int,array<string,mixed>> */
    private function standings(mysqli $connection, string $prefix, int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT p.id AS player_id,p.display_name,
                    COUNT(DISTINCT CASE WHEN m.status="completed" THEN m.id END) AS played,
                    COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id=p.id THEN m.id END) AS wins,
                    COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NULL THEN m.id END) AS draws,
                    COUNT(DISTINCT CASE WHEN m.status="completed" AND m.winner_player_id IS NOT NULL AND m.winner_player_id<>p.id THEN m.id END) AS losses,
                    COUNT(DISTINCT CASE WHEN l.winner_player_id=p.id THEN l.id END) AS legs_won,
                    COUNT(DISTINCT CASE WHEN l.winner_player_id IS NOT NULL AND l.winner_player_id<>p.id THEN l.id END) AS legs_lost,
                    COALESCE((SELECT ROUND(COALESCE(
                        SUM(ms.average * COALESCE(ms.darts_thrown,0)) / NULLIF(SUM(COALESCE(ms.darts_thrown,0)),0),
                        AVG(ms.average)
                    ),2)
                    FROM `%1$smatch_statistics` ms
                    INNER JOIN `%1$smatches` sm ON sm.id=ms.match_id
                    WHERE sm.tournament_id=? AND sm.status="completed" AND ms.player_id=p.id AND ms.average IS NOT NULL),0) AS three_dart_average
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             LEFT JOIN `%1$smatches` m ON m.tournament_id=tp.tournament_id AND (m.player_a_id=p.id OR m.player_b_id=p.id)
             LEFT JOIN `%1$slegs` l ON l.match_id=m.id
             WHERE tp.tournament_id=? AND tp.status NOT IN ("withdrawn","no_show")
             GROUP BY p.id,p.display_name',
            $prefix
        );
        $stmt = $connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            foreach (['player_id','played','wins','draws','losses','legs_won','legs_lost'] as $field) {
                $row[$field] = (int) ($row[$field] ?? 0);
            }
            $row['three_dart_average'] = round((float) ($row['three_dart_average'] ?? 0), 2);
            $row['points'] = ($row['wins'] * 2) + $row['draws'];
            $row['leg_diff'] = $row['legs_won'] - $row['legs_lost'];
        }
        unset($row);

        usort($rows, static function (array $a, array $b): int {
            $cmp = ((int) $b['points']) <=> ((int) $a['points']);
            if ($cmp !== 0) return $cmp;
            $cmp = ((int) $b['leg_diff']) <=> ((int) $a['leg_diff']);
            if ($cmp !== 0) return $cmp;
            $cmp = ((float) $b['three_dart_average']) <=> ((float) $a['three_dart_average']);
            return $cmp !== 0 ? $cmp : strcasecmp((string) $a['display_name'], (string) $b['display_name']);
        });
        foreach ($rows as $index => &$row) {
            $row['position'] = $index + 1;
        }
        unset($row);

        return array_slice($rows, 0, 8);
    }

    /** @return array<int,array<string,mixed>> */
    private function topVisits(mysqli $connection, string $prefix, int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT v.id,v.score,v.created_at,p.id AS player_id,p.display_name,m.id AS match_id,
                    m.round_label,m.bracket_label,k.board_number
             FROM `%1$svisits` v
             INNER JOIN `%1$smatches` m ON m.id=v.match_id
             INNER JOIN `%1$splayers` p ON p.id=v.player_id
             LEFT JOIN `%1$skiosks` k ON k.id=m.kiosk_id
             WHERE m.tournament_id=? AND v.is_bust=0
             ORDER BY v.score DESC,v.created_at ASC,v.id ASC
             LIMIT 3',
            $prefix
        );
        $stmt = $connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<int,array<string,mixed>> */
    private function topCheckouts(mysqli $connection, string $prefix, int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT p.id AS player_id,p.display_name,MAX(v.score) AS checkout
             FROM `%1$svisits` v
             INNER JOIN `%1$smatches` m ON m.id=v.match_id
             INNER JOIN `%1$splayers` p ON p.id=v.player_id
             WHERE m.tournament_id=? AND v.is_bust=0 AND v.remaining_after=0 AND v.score>0
             GROUP BY p.id,p.display_name
             ORDER BY checkout DESC,p.display_name ASC
             LIMIT 3',
            $prefix
        );
        $stmt = $connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }

    /** @return array<int,array<string,mixed>> */
    private function topThreeDartAverages(mysqli $connection, string $prefix, int $tournamentId): array
    {
        $sql = sprintf(
            'SELECT m.id AS match_id,p.id AS player_id,p.display_name,m.round_label,m.bracket_label,
                    ROUND(SUM(CASE WHEN v.is_bust=0 THEN v.score ELSE 0 END) * 3 / NULLIF(SUM(v.darts_used),0),2) AS three_dart_average,
                    SUM(v.darts_used) AS darts_thrown
             FROM `%1$svisits` v
             INNER JOIN `%1$smatches` m ON m.id=v.match_id
             INNER JOIN `%1$splayers` p ON p.id=v.player_id
             WHERE m.tournament_id=?
             GROUP BY m.id,p.id,p.display_name,m.round_label,m.bracket_label
             HAVING SUM(v.darts_used)>0
             ORDER BY three_dart_average DESC,darts_thrown DESC,p.display_name ASC
             LIMIT 3',
            $prefix
        );
        $stmt = $connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        return $rows;
    }
}
