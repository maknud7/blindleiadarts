<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use Blindleia\Dartkiosk\Api\Support\RuntimeFailureDiagnostics;

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
    $db = $database->connection();
    $prefix = $database->tablePrefix();
    $request = Request::fromGlobals();

    $payload = $request->method() === 'POST' ? $request->jsonBody() : [];
    $kioskCode = trim((string) ($payload['kiosk_code'] ?? $_GET['kiosk_code'] ?? ''));
    $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));

    if ($kioskCode === '' || $pairingToken === '') {
        $respond([
            'ok' => false,
            'error' => [
                'code' => 'kiosk_credentials_required',
                'message' => 'Kiosk-kode og pairing-token kreves.',
            ],
        ], 422);
    }

    $kiosksTable = $prefix . 'kiosks';
    $matchesTable = $prefix . 'matches';
    $playersTable = $prefix . 'players';
    $legsTable = $prefix . 'legs';
    $visitsTable = $prefix . 'visits';

    $kioskStatement = $db->prepare("SELECT id, pairing_token_hash FROM `{$kiosksTable}` WHERE code = ? AND is_active = 1 LIMIT 1");
    $kioskStatement->bind_param('s', $kioskCode);
    $kioskStatement->execute();
    $kiosk = $kioskStatement->get_result()->fetch_assoc() ?: null;
    $kioskStatement->close();

    if ($kiosk === null) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_not_found', 'message' => 'Kiosken finnes ikke.']], 404);
    }

    $pairingHash = trim((string) ($kiosk['pairing_token_hash'] ?? ''));
    if ($pairingHash === '' || !password_verify($pairingToken, $pairingHash)) {
        $respond(['ok' => false, 'error' => ['code' => 'kiosk_pairing_invalid', 'message' => 'Pairingen er ikke gyldig for denne terminalen.']], 403);
    }

    $kioskId = (int) $kiosk['id'];
    $matchStatement = $db->prepare(
        "SELECT id, status, player_a_id, player_b_id
         FROM `{$matchesTable}`
         WHERE kiosk_id = ? AND status IN ('in_progress', 'assigned')
         ORDER BY FIELD(status, 'in_progress', 'assigned'), id ASC
         LIMIT 1"
    );
    $matchStatement->bind_param('i', $kioskId);
    $matchStatement->execute();
    $match = $matchStatement->get_result()->fetch_assoc() ?: null;
    $matchStatement->close();

    if ($match === null) {
        $respond([
            'ok' => true,
            'data' => [
                'match_id' => null,
                'current_player_id' => null,
                'players' => [],
            ],
        ]);
    }

    $matchId = (int) $match['id'];
    $playerAId = (int) $match['player_a_id'];
    $playerBId = (int) $match['player_b_id'];
    $currentPlayerId = $playerAId;

    if ((string) $match['status'] === 'in_progress') {
        $legStatement = $db->prepare(
            "SELECT id, starting_player_id
             FROM `{$legsTable}`
             WHERE match_id = ? AND status IN ('pending', 'in_progress')
             ORDER BY leg_number DESC
             LIMIT 1"
        );
        $legStatement->bind_param('i', $matchId);
        $legStatement->execute();
        $leg = $legStatement->get_result()->fetch_assoc() ?: null;
        $legStatement->close();

        if ($leg !== null) {
            $legId = (int) $leg['id'];
            $visitStatement = $db->prepare("SELECT COUNT(*) AS total_visits FROM `{$visitsTable}` WHERE leg_id = ?");
            $visitStatement->bind_param('i', $legId);
            $visitStatement->execute();
            $visitCountRow = $visitStatement->get_result()->fetch_assoc() ?: ['total_visits' => 0];
            $visitStatement->close();

            $startingPlayerId = (int) $leg['starting_player_id'];
            $otherPlayerId = $startingPlayerId === $playerAId ? $playerBId : $playerAId;
            $currentPlayerId = ((int) $visitCountRow['total_visits'] % 2 === 0) ? $startingPlayerId : $otherPlayerId;
        }
    }

    if ($request->method() === 'POST') {
        $playerId = (int) ($payload['player_id'] ?? 0);
        $mode = trim((string) ($payload['preferred_input_mode'] ?? ''));

        if (!in_array($mode, ['sum', 'per_dart'], true)) {
            $respond(['ok' => false, 'error' => ['code' => 'invalid_input_mode', 'message' => 'Velg enten sum eller per pil.']], 422);
        }

        if (!in_array($playerId, [$playerAId, $playerBId], true)) {
            $respond(['ok' => false, 'error' => ['code' => 'player_not_in_match', 'message' => 'Spilleren tilhører ikke kampen på dette boardet.']], 403);
        }

        $update = $db->prepare("UPDATE `{$playersTable}` SET preferred_input_mode = ? WHERE id = ?");
        $update->bind_param('si', $mode, $playerId);
        $update->execute();
        $update->close();
    } elseif ($request->method() !== 'GET') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $playersStatement = $db->prepare(
        "SELECT id, display_name, preferred_input_mode
         FROM `{$playersTable}`
         WHERE id IN (?, ?)
         ORDER BY FIELD(id, ?, ?)"
    );
    $playersStatement->bind_param('iiii', $playerAId, $playerBId, $playerAId, $playerBId);
    $playersStatement->execute();
    $players = $playersStatement->get_result()->fetch_all(MYSQLI_ASSOC);
    $playersStatement->close();

    $respond([
        'ok' => true,
        'data' => [
            'match_id' => $matchId,
            'current_player_id' => $currentPlayerId,
            'players' => array_map(static fn (array $player): array => [
                'id' => (int) $player['id'],
                'display_name' => (string) $player['display_name'],
                'preferred_input_mode' => $player['preferred_input_mode'] !== null ? (string) $player['preferred_input_mode'] : null,
            ], $players),
        ],
    ]);
} catch (Throwable $error) {
    RuntimeFailureDiagnostics::log($config, 'kiosk_player_preference', $error, [
        'method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN'),
        'path' => (string) (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: ''),
    ]);
    $details = RuntimeFailureDiagnostics::details($config, $error);

    $respond([
        'ok' => false,
        'error' => [
            'code' => 'player_input_preference_unavailable',
            'message' => 'Spillerens scoringpreferanse kunne ikke lastes.',
            'request_id' => $details['request_id'],
            'detail' => $config !== null && $config->appEnv() === 'test' ? $error->getMessage() : null,
        ],
    ], 500);
}
