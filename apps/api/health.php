<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\PlayerPortalRepository;
use Blindleia\Dartkiosk\Api\Repository\TournamentRepository;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\MembershipDatabase;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$startedAt = microtime(true);
$deep = isset($_GET['deep']) && (string) $_GET['deep'] === '1';
$payload = [
    'ok' => false,
    'service' => 'blindleiadarts',
    'mode' => $deep ? 'deep' : 'basic',
    'generated_at' => gmdate('c'),
    'checks' => [],
    'diagnostics' => [],
];
$status = 503;

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);

    $diagnostics = [];
    $measure = static function (
        string $name,
        string $label,
        callable $callback,
        float $warnAfterMs = 1500.0
    ) use (&$diagnostics, $config): mixed {
        $started = microtime(true);
        try {
            $detail = $callback();
            $elapsed = round((microtime(true) - $started) * 1000, 1);
            $semanticStatus = null;
            if (is_array($detail) && isset($detail['__health_status'])) {
                $candidate = (string) $detail['__health_status'];
                if (in_array($candidate, ['ok', 'warn'], true)) {
                    $semanticStatus = $candidate;
                }
                unset($detail['__health_status']);
            }
            $diagnostics[] = [
                'name' => $name,
                'label' => $label,
                'status' => $semanticStatus ?? ($elapsed >= $warnAfterMs ? 'warn' : 'ok'),
                'ms' => $elapsed,
                'detail' => is_array($detail) ? $detail : null,
            ];
            return $detail;
        } catch (Throwable $error) {
            $elapsed = round((microtime(true) - $started) * 1000, 1);
            $diagnostics[] = [
                'name' => $name,
                'label' => $label,
                'status' => 'fail',
                'ms' => $elapsed,
                'detail' => [
                    'error' => $config->appEnv() !== 'prod' ? $error->getMessage() : 'check_failed',
                ],
            ];
            return null;
        }
    };

    $connectionStarted = microtime(true);
    $connection = $database->connection();
    $connection->query('SELECT 1');
    $databaseMs = round((microtime(true) - $connectionStarted) * 1000, 1);
    $diagnostics[] = [
        'name' => 'database',
        'label' => 'Databaseforbindelse',
        'status' => $databaseMs >= 1000 ? 'warn' : 'ok',
        'ms' => $databaseMs,
        'detail' => null,
    ];

    $prefix = $database->tablePrefix();
    $identityPrefix = $database->identityTablePrefix();

    $tableExists = static function (mysqli $db, string $table): bool {
        $statement = $db->prepare(
            'SELECT COUNT(*) AS cnt FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?'
        );
        $statement->bind_param('s', $table);
        $statement->execute();
        $exists = (int) ($statement->get_result()->fetch_assoc()['cnt'] ?? 0) === 1;
        $statement->close();
        return $exists;
    };

    $indexOnColumnExists = static function (mysqli $db, string $table, string $column): bool {
        $statement = $db->prepare(
            'SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $statement->bind_param('ss', $table, $column);
        $statement->execute();
        $exists = (int) ($statement->get_result()->fetch_assoc()['cnt'] ?? 0) > 0;
        $statement->close();
        return $exists;
    };

    $coreTable = $prefix . 'clubs';
    $coreReady = $tableExists($connection, $coreTable);

    $membership = new MembershipDatabase($config, $database, 'medlemmer');
    $memberConnection = $membership->connection();
    $memberSource = $membership->source();
    $memberReady = $memberConnection instanceof mysqli;

    $release = null;
    $releasePath = dirname(__DIR__) . '/release.json';
    if (is_file($releasePath)) {
        $decoded = json_decode((string) file_get_contents($releasePath), true);
        if (is_array($decoded)) {
            $release = [
                'environment' => isset($decoded['environment']) ? (string) $decoded['environment'] : null,
                'sha' => isset($decoded['sha']) ? (string) $decoded['sha'] : null,
            ];
        }
    }

    if ($deep) {
        $measure('core_schema', 'Kjerneschema', static function () use ($coreReady): array {
            if (!$coreReady) {
                throw new RuntimeException('Core clubs table is missing.');
            }
            return ['ready' => true];
        }, 500.0);

        $measure('member_registry', 'Medlemsregister', static function () use ($memberReady, $memberSource): array {
            if (!$memberReady) {
                throw new RuntimeException('Member registry connection is unavailable.');
            }
            return ['source' => $memberSource];
        }, 750.0);

        $measure('membership_lookup', 'Medlemskap og kontingent', static function () use ($connection, $tableExists): array {
            if (!$tableExists($connection, 'medlemmer')) {
                throw new RuntimeException('medlemmer table is missing.');
            }
            $row = $connection->query(
                'SELECT id, medlemsnummer FROM `medlemmer` ORDER BY id ASC LIMIT 1'
            )->fetch_assoc() ?: null;
            if ($row === null) {
                return ['sample' => false, 'payments_checked' => false];
            }
            $memberNumber = (int) ($row['medlemsnummer'] ?? 0);
            $paymentsChecked = false;
            if ($memberNumber > 0 && $tableExists($connection, 'kontingentbetalinger')) {
                $statement = $connection->prepare(
                    'SELECT dato, periode, belop, kilde
                     FROM `kontingentbetalinger`
                     WHERE medlemsnummer=?
                     ORDER BY dato DESC, id DESC LIMIT 24'
                );
                $statement->bind_param('i', $memberNumber);
                $statement->execute();
                $statement->get_result()->fetch_all(MYSQLI_ASSOC);
                $statement->close();
                $paymentsChecked = true;
            }
            return ['sample' => true, 'payments_checked' => $paymentsChecked];
        });

        $measure('critical_indexes', 'Kritiske databaseindekser', static function () use ($connection, $identityPrefix, $indexOnColumnExists, $tableExists): array {
            $sessions = $identityPrefix . 'auth_sessions';
            $sessionIndex = $tableExists($connection, $sessions)
                && $indexOnColumnExists($connection, $sessions, 'session_token_hash');
            $paymentIndex = !$tableExists($connection, 'kontingentbetalinger')
                || $indexOnColumnExists($connection, 'kontingentbetalinger', 'medlemsnummer');
            if (!$sessionIndex || !$paymentIndex) {
                throw new RuntimeException('A critical lookup index is missing.');
            }
            return [
                'auth_session_token' => $sessionIndex,
                'membership_number' => $paymentIndex,
            ];
        }, 750.0);

        $measure('stale_tournament_state', 'Gamle turneringer merket aktive', static function () use ($connection, $prefix): array {
            $tournaments = $prefix . 'tournaments';
            $matches = $prefix . 'matches';
            $sql = "SELECT t.id, t.name, t.status, t.start_at
                      FROM `{$tournaments}` t
                     WHERE t.status IN ('ready','in_progress')
                       AND t.start_at IS NOT NULL
                       AND t.start_at < DATE_SUB(NOW(), INTERVAL 18 HOUR)
                       AND (t.end_at IS NULL OR t.end_at < NOW())
                       AND NOT EXISTS (
                            SELECT 1 FROM `{$matches}` m
                             WHERE m.tournament_id=t.id
                               AND m.status IN ('assigned','in_progress')
                       )
                     ORDER BY t.start_at ASC
                     LIMIT 10";
            $rows = $connection->query($sql)->fetch_all(MYSQLI_ASSOC);
            return [
                '__health_status' => $rows === [] ? 'ok' : 'warn',
                'count' => count($rows),
                'sample' => $rows[0]['name'] ?? null,
                'sample_start_at' => $rows[0]['start_at'] ?? null,
            ];
        }, 750.0);

        $measure('stale_player_checkin', 'Gamle innsjekkinger står fortsatt aktive', static function () use ($connection, $prefix): array {
            $tournaments = $prefix . 'tournaments';
            $registrations = $prefix . 'tournament_players';
            $players = $prefix . 'players';
            $matches = $prefix . 'matches';
            $sql = "SELECT tp.player_id, p.display_name, t.id AS tournament_id, t.name AS tournament_name,
                           t.status AS tournament_status, t.start_at, tp.status AS registration_status
                      FROM `{$registrations}` tp
                      INNER JOIN `{$tournaments}` t ON t.id=tp.tournament_id
                      INNER JOIN `{$players}` p ON p.id=tp.player_id
                     WHERE tp.status IN ('checked_in','paused')
                       AND (
                            t.status IN ('completed','cancelled')
                            OR (
                                t.start_at IS NULL
                                AND NOT EXISTS (
                                    SELECT 1 FROM `{$matches}` m0
                                     WHERE m0.tournament_id=t.id
                                       AND (m0.player_a_id=tp.player_id OR m0.player_b_id=tp.player_id)
                                       AND m0.status IN ('assigned','in_progress')
                                )
                            )
                            OR (
                                t.start_at IS NOT NULL
                                AND t.start_at < DATE_SUB(NOW(), INTERVAL 18 HOUR)
                                AND (t.end_at IS NULL OR t.end_at < NOW())
                                AND NOT EXISTS (
                                    SELECT 1 FROM `{$matches}` m1
                                     WHERE m1.tournament_id=t.id
                                       AND (m1.player_a_id=tp.player_id OR m1.player_b_id=tp.player_id)
                                       AND m1.status IN ('assigned','in_progress')
                                )
                            )
                       )
                     ORDER BY COALESCE(t.start_at,'1000-01-01') ASC, t.id ASC, p.display_name ASC
                     LIMIT 10";
            $rows = $connection->query($sql)->fetch_all(MYSQLI_ASSOC);
            return [
                '__health_status' => $rows === [] ? 'ok' : 'warn',
                'count' => count($rows),
                'sample_player' => $rows[0]['display_name'] ?? null,
                'sample_tournament' => $rows[0]['tournament_name'] ?? null,
                'sample_start_at' => $rows[0]['start_at'] ?? null,
                'sample_tournament_status' => $rows[0]['tournament_status'] ?? null,
                'sample_registration_status' => $rows[0]['registration_status'] ?? null,
            ];
        }, 750.0);

        $samplePlayerId = 0;
        $measure('player_profile', 'Spillerprofil', static function () use ($connection, $prefix, $database, &$samplePlayerId): array {
            $players = $prefix . 'players';
            $matches = $prefix . 'matches';
            $sql = "SELECT p.id
                      FROM `{$players}` p
                     WHERE p.is_active=1
                     ORDER BY EXISTS(
                        SELECT 1 FROM `{$matches}` m
                         WHERE m.status='completed' AND (m.player_a_id=p.id OR m.player_b_id=p.id)
                     ) DESC, p.id ASC
                     LIMIT 1";
            $row = $connection->query($sql)->fetch_assoc() ?: null;
            $samplePlayerId = (int) ($row['id'] ?? 0);
            if ($samplePlayerId <= 0) {
                return ['sample' => false];
            }
            $repository = new PlayerPortalRepository($database);
            $profile = $repository->getPlayerProfile($samplePlayerId);
            if ($profile === null) {
                throw new RuntimeException('Representative player profile could not be loaded.');
            }
            return [
                'sample' => true,
                'matches' => (int) ($profile['stats']['matches_played'] ?? 0),
            ];
        }, 1500.0);

        $measure('player_matches', 'Kamphistorikk', static function () use ($database, &$samplePlayerId): array {
            if ($samplePlayerId <= 0) {
                return ['sample' => false, 'count' => 0];
            }
            $repository = new PlayerPortalRepository($database);
            $items = $repository->listPlayerMatches($samplePlayerId, 20);
            return ['sample' => true, 'count' => count($items)];
        }, 1500.0);

        $measure('member_dashboard', 'Innlogget Min side-dashboard', static function () use ($connection, $identityPrefix, $database, $tableExists): array {
            $users = $identityPrefix . 'user_accounts';
            if (!$tableExists($connection, $users)) {
                throw new RuntimeException('User accounts table is missing.');
            }
            $row = $connection->query(
                "SELECT id FROM `{$users}`
                  WHERE is_active=1 AND account_status='active'
                  ORDER BY CASE WHEN player_id IS NULL THEN 1 ELSE 0 END ASC, id ASC
                  LIMIT 1"
            )->fetch_assoc() ?: null;
            $userId = (int) ($row['id'] ?? 0);
            if ($userId <= 0) {
                return ['sample' => false];
            }
            $repository = new TournamentRepository($database);
            $dashboard = $repository->getMemberDashboard($userId);
            return [
                'sample' => true,
                'available' => is_array($dashboard),
                'registrations' => is_array($dashboard) ? count((array) ($dashboard['registrations'] ?? [])) : 0,
            ];
        }, 1500.0);
    }

    $hasFailure = false;
    foreach ($diagnostics as $diagnostic) {
        if (($diagnostic['status'] ?? null) === 'fail') {
            $hasFailure = true;
            break;
        }
    }

    $payload = [
        'ok' => $coreReady && $memberReady && !$hasFailure,
        'service' => 'blindleiadarts',
        'app_env' => $config->appEnv(),
        'mode' => $deep ? 'deep' : 'basic',
        'generated_at' => gmdate('c'),
        'duration_ms' => round((microtime(true) - $startedAt) * 1000, 1),
        'release' => $release,
        'checks' => [
            'database' => true,
            'core_schema' => $coreReady,
            'member_registry' => $memberReady,
        ],
        'member_registry' => [
            'source' => $memberSource,
        ],
        'diagnostics' => $diagnostics,
    ];
    $status = $payload['ok'] ? 200 : 503;
} catch (Throwable $error) {
    $payload['duration_ms'] = round((microtime(true) - $startedAt) * 1000, 1);
    $payload['checks']['database'] = false;
    $payload['error'] = [
        'code' => 'internal_health_failed',
        'message' => 'BlindleiaDarts internal health check failed.',
        'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
    ];
}

http_response_code($status);
echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);