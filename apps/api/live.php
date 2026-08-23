<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

function live_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode(
        $payload,
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    exit;
}

function live_identifier(string $value): string
{
    if (!preg_match('/^[A-Za-z0-9_]*$/', $value)) {
        throw new InvalidArgumentException('Unsafe table prefix.');
    }
    return $value;
}

function live_nullable_int(mixed $value): ?int
{
    return $value === null ? null : (int) $value;
}

function live_nullable_float(mixed $value): ?float
{
    return $value === null ? null : (float) $value;
}

function live_player_name(array $row, string $side): string
{
    $nickname = trim((string) ($row[$side . '_nickname'] ?? ''));
    $name = trim((string) ($row[$side . '_name'] ?? ''));
    return $nickname !== '' ? $name . ' “' . $nickname . '”' : $name;
}

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    live_json(['ok' => false, 'error' => 'api_not_configured'], 503);
}

try {
    $config = require $configPath;
    if (!is_array($config) || !isset($config['db']) || !is_array($config['db'])) {
        throw new RuntimeException('Invalid API config.');
    }

    $dbConfig = $config['db'];
    $prefix = live_identifier((string) ($dbConfig['table_prefix'] ?? ''));
    $table = static fn(string $name): string => '`' . $prefix . $name . '`';

    mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
    $db = new mysqli(
        (string) $dbConfig['host'],
        (string) $dbConfig['username'],
        (string) $dbConfig['password'],
        (string) $dbConfig['database'],
        (int) ($dbConfig['port'] ?? 3306),
    );
    $db->set_charset('utf8mb4');

    $requestedTournament = filter_input(INPUT_GET, 'tournament_id', FILTER_VALIDATE_INT);
    $requestedTournament = is_int($requestedTournament) && $requestedTournament > 0
        ? $requestedTournament
        : null;

    $tournaments = $table('tournaments');
    $matches = $table('matches');
    $clubs = $table('clubs');
    $seasons = $table('seasons');

    $baseTournamentSql = "
        SELECT
            t.id,
            t.name,
            t.status,
            t.start_at,
            t.end_at,
            t.updated_at,
            c.name AS club_name,
            c.logo_url AS club_logo_url,
            s.name AS season_name,
            SUM(CASE WHEN m.status = 'in_progress' THEN 1 ELSE 0 END) AS live_count,
            SUM(CASE WHEN m.status IN ('pending', 'assigned') THEN 1 ELSE 0 END) AS upcoming_count,
            MAX(m.updated_at) AS last_match_update
        FROM {$tournaments} t
        JOIN {$clubs} c ON c.id = t.club_id
        LEFT JOIN {$seasons} s ON s.id = t.season_id
        LEFT JOIN {$matches} m ON m.tournament_id = t.id
    ";

    if ($requestedTournament !== null) {
        $stmt = $db->prepare($baseTournamentSql . " WHERE t.id = ? GROUP BY t.id LIMIT 1");
        $stmt->bind_param('i', $requestedTournament);
        $stmt->execute();
        $tournament = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
    } else {
        $result = $db->query(
            $baseTournamentSql . "
                GROUP BY t.id
                HAVING COUNT(m.id) > 0
                ORDER BY
                    (SUM(CASE WHEN m.status = 'in_progress' THEN 1 ELSE 0 END) > 0) DESC,
                    (SUM(CASE WHEN m.status IN ('pending', 'assigned') THEN 1 ELSE 0 END) > 0) DESC,
                    COALESCE(MAX(m.updated_at), t.updated_at) DESC,
                    t.id DESC
                LIMIT 1
            "
        );
        $tournament = $result->fetch_assoc() ?: null;
        $result->free();
    }

    if ($tournament === null) {
        $db->close();
        live_json([
            'ok' => true,
            'generated_at' => gmdate('c'),
            'tournament' => null,
            'feed' => ['status' => 'idle', 'age_seconds' => null, 'last_seen_at' => null],
            'matches' => ['live' => [], 'upcoming' => [], 'recent' => []],
            'highlights' => ['total_180' => 0, 'highest_checkout' => null, 'best_average' => null],
            'leaderboard' => [],
        ]);
    }

    $tournamentId = (int) $tournament['id'];
    $players = $table('players');
    $kiosks = $table('kiosks');
    $liveStates = $table('live_match_states');
    $stats = $table('match_statistics');
    $externalReferences = $table('external_references');

    $stmt = $db->prepare("
        SELECT
            m.id,
            m.status,
            m.round_label,
            m.bracket_label,
            m.best_of_legs,
            m.legs_to_win,
            m.winner_player_id,
            m.starts_at,
            m.finished_at,
            m.updated_at,
            k.board_number,
            k.name AS board_name,
            pa.id AS player_a_id,
            pa.display_name AS player_a_name,
            pa.nickname AS player_a_nickname,
            pa.avatar_url AS player_a_avatar,
            pa.member_id AS player_a_member_id,
            pb.id AS player_b_id,
            pb.display_name AS player_b_name,
            pb.nickname AS player_b_nickname,
            pb.avatar_url AS player_b_avatar,
            pb.member_id AS player_b_member_id,
            lms.player_a_score,
            lms.player_b_score,
            lms.player_a_legs,
            lms.player_b_legs,
            lms.provider_status,
            lms.provider_updated_at,
            sa.average AS player_a_average,
            sa.first_nine_average AS player_a_first_nine,
            sa.darts_thrown AS player_a_darts_thrown,
            sa.checkout_hits AS player_a_checkout_hits,
            sa.checkout_attempts AS player_a_checkout_attempts,
            sa.highest_checkout AS player_a_highest_checkout,
            sa.score_180 AS player_a_180,
            sb.average AS player_b_average,
            sb.first_nine_average AS player_b_first_nine,
            sb.darts_thrown AS player_b_darts_thrown,
            sb.checkout_hits AS player_b_checkout_hits,
            sb.checkout_attempts AS player_b_checkout_attempts,
            sb.highest_checkout AS player_b_highest_checkout,
            sb.score_180 AS player_b_180,
            er.external_id AS provider_match_id
        FROM {$matches} m
        JOIN {$players} pa ON pa.id = m.player_a_id
        JOIN {$players} pb ON pb.id = m.player_b_id
        LEFT JOIN {$kiosks} k ON k.id = m.kiosk_id
        LEFT JOIN {$liveStates} lms ON lms.match_id = m.id
        LEFT JOIN {$stats} sa ON sa.match_id = m.id AND sa.player_id = m.player_a_id
        LEFT JOIN {$stats} sb ON sb.match_id = m.id AND sb.player_id = m.player_b_id
        LEFT JOIN {$externalReferences} er
            ON er.external_system = 'dartsatlas'
           AND er.external_entity_type = 'match'
           AND er.internal_entity_type = 'match'
           AND er.internal_id = m.id
        WHERE m.tournament_id = ?
        ORDER BY
            FIELD(m.status, 'in_progress', 'assigned', 'pending', 'completed', 'cancelled'),
            COALESCE(k.board_number, 9999),
            COALESCE(m.starts_at, m.created_at),
            m.id
    ");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $rows = $stmt->get_result();

    $live = [];
    $upcoming = [];
    $recent = [];

    while ($row = $rows->fetch_assoc()) {
        $match = [
            'id' => (int) $row['id'],
            'provider_match_id' => $row['provider_match_id'],
            'status' => $row['status'],
            'round' => $row['round_label'],
            'bracket' => $row['bracket_label'],
            'best_of_legs' => (int) $row['best_of_legs'],
            'legs_to_win' => (int) $row['legs_to_win'],
            'board' => [
                'number' => live_nullable_int($row['board_number']),
                'name' => $row['board_name'],
            ],
            'starts_at' => $row['starts_at'],
            'finished_at' => $row['finished_at'],
            'updated_at' => $row['provider_updated_at'] ?? $row['updated_at'],
            'players' => [
                'a' => [
                    'id' => (int) $row['player_a_id'],
                    'member_id' => live_nullable_int($row['player_a_member_id']),
                    'name' => (string) $row['player_a_name'],
                    'display_name' => live_player_name($row, 'player_a'),
                    'nickname' => $row['player_a_nickname'],
                    'avatar_url' => $row['player_a_avatar'],
                    'score' => live_nullable_int($row['player_a_score']),
                    'legs' => live_nullable_int($row['player_a_legs']),
                    'winner' => (int) ($row['winner_player_id'] ?? 0) === (int) $row['player_a_id'],
                    'stats' => [
                        'average' => live_nullable_float($row['player_a_average']),
                        'first_nine' => live_nullable_float($row['player_a_first_nine']),
                        'darts_thrown' => live_nullable_int($row['player_a_darts_thrown']),
                        'checkout_hits' => live_nullable_int($row['player_a_checkout_hits']),
                        'checkout_attempts' => live_nullable_int($row['player_a_checkout_attempts']),
                        'highest_checkout' => live_nullable_int($row['player_a_highest_checkout']),
                        '180s' => live_nullable_int($row['player_a_180']) ?? 0,
                    ],
                ],
                'b' => [
                    'id' => (int) $row['player_b_id'],
                    'member_id' => live_nullable_int($row['player_b_member_id']),
                    'name' => (string) $row['player_b_name'],
                    'display_name' => live_player_name($row, 'player_b'),
                    'nickname' => $row['player_b_nickname'],
                    'avatar_url' => $row['player_b_avatar'],
                    'score' => live_nullable_int($row['player_b_score']),
                    'legs' => live_nullable_int($row['player_b_legs']),
                    'winner' => (int) ($row['winner_player_id'] ?? 0) === (int) $row['player_b_id'],
                    'stats' => [
                        'average' => live_nullable_float($row['player_b_average']),
                        'first_nine' => live_nullable_float($row['player_b_first_nine']),
                        'darts_thrown' => live_nullable_int($row['player_b_darts_thrown']),
                        'checkout_hits' => live_nullable_int($row['player_b_checkout_hits']),
                        'checkout_attempts' => live_nullable_int($row['player_b_checkout_attempts']),
                        'highest_checkout' => live_nullable_int($row['player_b_highest_checkout']),
                        '180s' => live_nullable_int($row['player_b_180']) ?? 0,
                    ],
                ],
            ],
        ];

        if ($row['status'] === 'in_progress') {
            $live[] = $match;
        } elseif (in_array($row['status'], ['assigned', 'pending'], true)) {
            $upcoming[] = $match;
        } elseif ($row['status'] === 'completed') {
            $recent[] = $match;
        }
    }
    $rows->free();
    $stmt->close();

    usort($recent, static function (array $a, array $b): int {
        return strcmp((string) ($b['finished_at'] ?? $b['updated_at'] ?? ''), (string) ($a['finished_at'] ?? $a['updated_at'] ?? ''));
    });
    $recent = array_slice($recent, 0, 8);
    $upcoming = array_slice($upcoming, 0, 8);

    $stmt = $db->prepare("
        SELECT
            COALESCE(SUM(COALESCE(ms.score_180, 0)), 0) AS total_180,
            MAX(ms.highest_checkout) AS highest_checkout
        FROM {$stats} ms
        JOIN {$matches} m ON m.id = ms.match_id
        WHERE m.tournament_id = ?
    ");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $highlightBase = $stmt->get_result()->fetch_assoc() ?: [];
    $stmt->close();

    $stmt = $db->prepare("
        SELECT p.id, p.display_name, p.nickname, ms.average, m.id AS match_id
        FROM {$stats} ms
        JOIN {$matches} m ON m.id = ms.match_id
        JOIN {$players} p ON p.id = ms.player_id
        WHERE m.tournament_id = ? AND ms.average IS NOT NULL
        ORDER BY ms.average DESC, ms.id DESC
        LIMIT 1
    ");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $bestAverageRow = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    $stmt = $db->prepare("
        SELECT p.id, p.display_name, p.nickname, ms.highest_checkout, m.id AS match_id
        FROM {$stats} ms
        JOIN {$matches} m ON m.id = ms.match_id
        JOIN {$players} p ON p.id = ms.player_id
        WHERE m.tournament_id = ? AND ms.highest_checkout IS NOT NULL
        ORDER BY ms.highest_checkout DESC, ms.id DESC
        LIMIT 1
    ");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $highestCheckoutRow = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    $tournamentPlayers = $table('tournament_players');
    $stmt = $db->prepare("
        SELECT
            p.id,
            p.display_name,
            p.nickname,
            p.member_id,
            COUNT(DISTINCT m.id) AS matches_played,
            SUM(CASE WHEN m.winner_player_id = p.id THEN 1 ELSE 0 END) AS wins,
            COALESCE(SUM(COALESCE(ms.score_180, 0)), 0) AS total_180,
            MAX(ms.highest_checkout) AS highest_checkout,
            ROUND(AVG(ms.average), 2) AS average
        FROM {$tournamentPlayers} tp
        JOIN {$players} p ON p.id = tp.player_id
        LEFT JOIN {$matches} m
            ON m.tournament_id = tp.tournament_id
           AND (m.player_a_id = p.id OR m.player_b_id = p.id)
           AND m.status = 'completed'
        LEFT JOIN {$stats} ms ON ms.match_id = m.id AND ms.player_id = p.id
        WHERE tp.tournament_id = ?
        GROUP BY p.id
        HAVING matches_played > 0
        ORDER BY wins DESC, average DESC, total_180 DESC, p.display_name
        LIMIT 10
    ");
    $stmt->bind_param('i', $tournamentId);
    $stmt->execute();
    $leaderboardResult = $stmt->get_result();
    $leaderboard = [];
    while ($row = $leaderboardResult->fetch_assoc()) {
        $leaderboard[] = [
            'player_id' => (int) $row['id'],
            'member_id' => live_nullable_int($row['member_id']),
            'name' => (string) $row['display_name'],
            'nickname' => $row['nickname'],
            'matches_played' => (int) $row['matches_played'],
            'wins' => (int) $row['wins'],
            'average' => live_nullable_float($row['average']),
            '180s' => (int) $row['total_180'],
            'highest_checkout' => live_nullable_int($row['highest_checkout']),
        ];
    }
    $leaderboardResult->free();
    $stmt->close();

    $connectorResources = $table('connector_resources');
    $resourceResult = $db->query("
        SELECT MAX(last_seen_at) AS last_seen_at
        FROM {$connectorResources}
        WHERE external_system = 'dartsatlas'
    ");
    $resourceRow = $resourceResult->fetch_assoc() ?: [];
    $resourceResult->free();

    $lastSeenAt = $resourceRow['last_seen_at'] ?? null;
    $ageSeconds = $lastSeenAt !== null ? max(0, time() - strtotime((string) $lastSeenAt)) : null;
    $feedStatus = $ageSeconds === null
        ? 'idle'
        : ($ageSeconds <= 30 ? 'live' : ($ageSeconds <= 120 ? 'delayed' : 'stale'));

    $syncJobs = $table('connector_sync_jobs');
    $jobResult = $db->query("
        SELECT status, job_type, started_at, finished_at, error_message
        FROM {$syncJobs}
        WHERE external_system = 'dartsatlas'
        ORDER BY id DESC
        LIMIT 1
    ");
    $lastJob = $jobResult->fetch_assoc() ?: null;
    $jobResult->free();

    $displayPlayer = static function (?array $row): ?array {
        if ($row === null) {
            return null;
        }
        return [
            'player_id' => (int) $row['id'],
            'name' => (string) $row['display_name'],
            'nickname' => $row['nickname'],
        ];
    };

    $payload = [
        'ok' => true,
        'generated_at' => gmdate('c'),
        'tournament' => [
            'id' => $tournamentId,
            'name' => (string) $tournament['name'],
            'status' => (string) $tournament['status'],
            'club_name' => (string) $tournament['club_name'],
            'club_logo_url' => $tournament['club_logo_url'],
            'season_name' => $tournament['season_name'],
            'start_at' => $tournament['start_at'],
            'end_at' => $tournament['end_at'],
        ],
        'feed' => [
            'status' => $feedStatus,
            'age_seconds' => $ageSeconds,
            'last_seen_at' => $lastSeenAt,
            'last_job' => $lastJob,
        ],
        'matches' => [
            'live' => $live,
            'upcoming' => $upcoming,
            'recent' => $recent,
        ],
        'highlights' => [
            'total_180' => (int) ($highlightBase['total_180'] ?? 0),
            'highest_checkout' => $highestCheckoutRow === null ? null : [
                'value' => (int) $highestCheckoutRow['highest_checkout'],
                'player' => $displayPlayer($highestCheckoutRow),
                'match_id' => (int) $highestCheckoutRow['match_id'],
            ],
            'best_average' => $bestAverageRow === null ? null : [
                'value' => (float) $bestAverageRow['average'],
                'player' => $displayPlayer($bestAverageRow),
                'match_id' => (int) $bestAverageRow['match_id'],
            ],
        ],
        'leaderboard' => $leaderboard,
    ];

    $db->close();
    live_json($payload);
} catch (Throwable $error) {
    $isProd = isset($config) && is_array($config) && (($config['app_env'] ?? '') === 'prod');
    live_json([
        'ok' => false,
        'error' => 'live_api_unavailable',
        'detail' => $isProd ? null : $error->getMessage(),
    ], 503);
}
