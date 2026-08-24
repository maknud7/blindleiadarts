<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Http\Request;
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

$generateCode = static function (): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $code = '';
    for ($i = 0; $i < 6; $i++) {
        $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $code;
};

try {
    $config = Config::load(__DIR__);
    $database = new Database($config);
    $db = $database->connection();
    $request = Request::fromGlobals();

    if ($request->method() !== 'POST') {
        $respond(['ok' => false, 'error' => ['code' => 'method_not_allowed', 'message' => 'Metoden støttes ikke.']], 405);
    }

    $pairingToken = trim((string) ($request->header('x-kiosk-pairing-token') ?? ''));
    if ($pairingToken === '' || strlen($pairingToken) < 16) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_token_required', 'message' => 'Terminalen mangler gyldig device-token.']], 422);
    }

    $table = $database->tablePrefix() . 'kiosk_pairing_requests';
    $fingerprint = hash('sha256', $pairingToken);
    $statement = $db->prepare("SELECT id FROM `{$table}` WHERE pairing_token_fingerprint = ? AND status = 'pending' LIMIT 1");
    $statement->bind_param('s', $fingerprint);
    $statement->execute();
    $row = $statement->get_result()->fetch_assoc() ?: null;
    $statement->close();

    if ($row === null) {
        $respond(['ok' => false, 'error' => ['code' => 'pairing_not_pending', 'message' => 'Det finnes ingen aktiv pairing å fornye.']], 404);
    }

    do {
        $code = $generateCode();
        $check = $db->prepare("SELECT id FROM `{$table}` WHERE request_code = ? LIMIT 1");
        $check->bind_param('s', $code);
        $check->execute();
        $exists = $check->get_result()->fetch_assoc() !== null;
        $check->close();
    } while ($exists);

    $expiresAt = date('Y-m-d H:i:s', time() + 1800);
    $requestId = (int) $row['id'];
    $update = $db->prepare("UPDATE `{$table}` SET request_code = ?, requested_at = NOW(), expires_at = ? WHERE id = ? AND status = 'pending'");
    $update->bind_param('ssi', $code, $expiresAt, $requestId);
    $update->execute();
    $update->close();

    $respond([
        'ok' => true,
        'data' => [
            'request' => [
                'request_code' => $code,
                'expires_at' => $expiresAt,
            ],
        ],
    ]);
} catch (Throwable $error) {
    $respond([
        'ok' => false,
        'error' => [
            'code' => 'pairing_renew_failed',
            'message' => 'Kunne ikke fornye pairingkoden.',
            'detail' => isset($config) && $config->appEnv() !== 'prod' ? $error->getMessage() : null,
        ],
    ], 500);
}
