<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Repository\KioskAccessException;
use Blindleia\Dartkiosk\Api\Repository\KioskRepository;
use Blindleia\Dartkiosk\Api\Repository\ScoliaRepository;
use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\CanonicalScoringService;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;
use Blindleia\Dartkiosk\Api\Service\ScoliaScoringService;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$respond = static function (array $payload, int $status = 200): never {
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
};

$config = null;

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $request = Request::fromGlobals();
    $method = $request->method();
    $action = strtolower(trim((string) ($_GET['action'] ?? ($method === 'POST' ? 'undo' : 'status'))));
    $body = $method === 'POST' ? $request->jsonBody() : [];
    $code = trim((string) ($_GET['kiosk_code'] ?? $body['kiosk_code'] ?? ''));
    $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));

    if ($code === '' || $pairingToken === '') {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_context_required', 'message' => 'Skiveterminalen mangler pairinginformasjon.']], 422);
    }

    $kiosks = new KioskRepository($database);
    $snapshot = $kiosks->findKioskStateByCode($code, $pairingToken);
    if ($snapshot === null) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Skiveterminalen ble ikke funnet.']], 404);
    }

    $kiosk = is_array($snapshot['kiosk'] ?? null) ? $snapshot['kiosk'] : [];
    $kioskId = (int) ($kiosk['id'] ?? 0);
    $clubId = (int) ($kiosk['club']['id'] ?? 0);
    $matchId = (int) (($snapshot['match']['id'] ?? 0));
    if ($kioskId <= 0 || $clubId <= 0) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_context_invalid', 'message' => 'Skiveterminalen mangler klubbkobling.']], 409);
    }

    $prefix = $database->tablePrefix();
    if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
        throw new RuntimeException('Ugyldig tabellprefiks.');
    }
    $db = $database->connection();

    $latestVisit = static function (int $targetKioskId, int $targetMatchId = 0, bool $scoliaOnly = true) use ($db, $prefix): ?array {
        $sourceFilter = $scoliaOnly ? " AND v.request_key LIKE 'scolia-%'" : '';
        if ($targetMatchId > 0) {
            $sql = "SELECT v.id,v.match_id,v.leg_id,v.player_id,v.visit_number,v.score,v.darts_used,v.input_mode,\n"
                 . "       v.darts_json,v.is_bust,v.remaining_after,v.request_key,v.created_at,p.display_name AS player_name\n"
                 . "FROM `{$prefix}visits` v\n"
                 . "INNER JOIN `{$prefix}matches` m ON m.id=v.match_id\n"
                 . "LEFT JOIN `{$prefix}players` p ON p.id=v.player_id\n"
                 . "WHERE m.kiosk_id=? AND v.match_id=?{$sourceFilter}\n"
                 . "ORDER BY v.id DESC LIMIT 1";
            $stmt = $db->prepare($sql);
            $stmt->bind_param('ii', $targetKioskId, $targetMatchId);
        } else {
            $sql = "SELECT v.id,v.match_id,v.leg_id,v.player_id,v.visit_number,v.score,v.darts_used,v.input_mode,\n"
                 . "       v.darts_json,v.is_bust,v.remaining_after,v.request_key,v.created_at,p.display_name AS player_name\n"
                 . "FROM `{$prefix}visits` v\n"
                 . "INNER JOIN `{$prefix}matches` m ON m.id=v.match_id\n"
                 . "LEFT JOIN `{$prefix}players` p ON p.id=v.player_id\n"
                 . "WHERE m.kiosk_id=?{$sourceFilter}\n"
                 . "ORDER BY v.id DESC LIMIT 1";
            $stmt = $db->prepare($sql);
            $stmt->bind_param('i', $targetKioskId);
        }
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;

        $darts = json_decode((string) ($row['darts_json'] ?? '[]'), true);
        return [
            'id' => (int) $row['id'],
            'match_id' => (int) $row['match_id'],
            'leg_id' => (int) $row['leg_id'],
            'player_id' => (int) $row['player_id'],
            'player_name' => (string) ($row['player_name'] ?? ''),
            'visit_number' => (int) $row['visit_number'],
            'score' => (int) $row['score'],
            'darts_used' => (int) $row['darts_used'],
            'input_mode' => (string) $row['input_mode'],
            'darts' => is_array($darts) ? array_values($darts) : [],
            'is_bust' => (int) $row['is_bust'] === 1,
            'remaining_after' => (int) $row['remaining_after'],
            'source' => str_starts_with((string) ($row['request_key'] ?? ''), 'scolia-') ? 'scolia' : 'manual',
            'created_at' => $row['created_at'],
        ];
    };

    $repo = new ScoliaRepository($database);
    $canonical = new CanonicalScoringService($database, $config);
    $scolia = new ScoliaScoringService($repo, $canonical, new Dart501Rules());

    if ($method === 'GET' && $action === 'status') {
        $board = $repo->getBoardRuntimeStatus($clubId, $kioskId);
        $respond([
            'ok' => true,
            'data' => [
                'board' => $board,
                'match_id' => $matchId > 0 ? $matchId : null,
                'last_visit' => $matchId > 0 ? $latestVisit($kioskId, $matchId, true) : null,
            ],
        ]);
    }

    if ($method === 'POST' && $action === 'undo') {
        $board = $repo->getBoardRuntimeStatus($clubId, $kioskId);
        $buffer = is_array($board['buffer'] ?? null) ? $board['buffer'] : null;
        $bufferDarts = is_array($buffer['darts'] ?? null) ? $buffer['darts'] : [];

        if ($bufferDarts !== []) {
            $result = $scolia->deleteBufferedThrow($clubId, $kioskId, null, 0);
            $respond([
                'ok' => true,
                'data' => [
                    'action' => 'buffered_throw_removed',
                    'result' => $result,
                    'board' => $repo->getBoardRuntimeStatus($clubId, $kioskId),
                    'last_visit' => $matchId > 0 ? $latestVisit($kioskId, $matchId, true) : null,
                ],
            ]);
        }

        if ($matchId <= 0) {
            $respond(['ok' => false, 'error' => ['code' => 'active_match_required', 'message' => 'Det finnes ingen aktiv kamp å angre i.']], 409);
        }

        $latestCanonical = $latestVisit($kioskId, $matchId, false);
        if ($latestCanonical === null) {
            $respond(['ok' => false, 'error' => ['code' => 'visit_not_found', 'message' => 'Det finnes ikke noe kast å angre.']], 409);
        }
        if (($latestCanonical['source'] ?? '') !== 'scolia') {
            $respond(['ok' => false, 'error' => ['code' => 'latest_visit_not_scolia', 'message' => 'Siste kast ble ikke registrert av Scolia og kan ikke angres fra Scolia-knappen.']], 409);
        }

        $canonical->undoLastVisit($kioskId, 'scolia');
        $reset = $scolia->resetPhase($clubId, $kioskId, 0);
        $respond([
            'ok' => true,
            'data' => [
                'action' => 'visit_undone',
                'reset_command' => $reset,
                'board' => $repo->getBoardRuntimeStatus($clubId, $kioskId),
                'last_visit' => $latestVisit($kioskId, $matchId, true),
            ],
        ]);
    }

    $respond(['ok' => false, 'error' => ['code' => 'route_not_found', 'message' => 'Ukjent Scolia-handling.']], 404);
} catch (KioskAccessException $error) {
    $respond(['ok' => false, 'error' => ['code' => $error->errorCode(), 'message' => $error->getMessage()]], $error->statusCode());
} catch (ValidationException $error) {
    $respond(['ok' => false, 'error' => ['code' => $error->errorCode(), 'message' => $error->getMessage()]], $error->statusCode());
} catch (Throwable $error) {
    $respond(['ok' => false, 'error' => ['code' => 'internal_server_error', 'message' => 'Scolia-handlingen feilet.', 'details' => $config?->appEnv() === 'test' ? $error->getMessage() : null]], 500);
}
