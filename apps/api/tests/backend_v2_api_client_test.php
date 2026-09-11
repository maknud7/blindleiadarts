<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\BackendV2ApiAttemptException;
use Blindleia\Dartkiosk\Api\Service\BackendV2ApiClient;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$requests = [];
$client = new BackendV2ApiClient(
    'https://backend.example.test',
    'internal-test-token',
    static function (string $method, string $url, array $headers, ?string $body, int $connectMs, int $totalMs) use (&$requests): array {
        $requests[] = compact('method', 'url', 'headers', 'body', 'connectMs', 'totalMs');
        return ['status' => 200, 'body' => '{"ok":true,"kiosk":{"id":"9223372036854775808"}}'];
    },
    900,
    4200
);
$result = $client->request(
    'PATCH',
    '/v1/clubs/1/kiosks/9223372036854775808',
    ['name' => 'Skive test'],
    ['authorization' => 'Bearer session-token', 'x-kiosk-pairing-token' => 'pair-token']
);
$assert(($result['payload']['kiosk']['id'] ?? null) === '9223372036854775808', 'BIGINT response IDs must remain decimal strings.');
$assert(count($requests) === 1, 'A request must result in exactly one transport attempt.');
$assert($requests[0]['method'] === 'PATCH', 'HTTP method was not preserved.');
$assert(str_ends_with($requests[0]['url'], '/v1/clubs/1/kiosks/9223372036854775808'), 'Public API path was not preserved.');
$assert(in_array('authorization: Bearer session-token', $requests[0]['headers'], true), 'Bearer token was not forwarded.');
$assert(in_array('x-kiosk-pairing-token: pair-token', $requests[0]['headers'], true), 'Pairing token was not forwarded.');
$assert(in_array('x-bd-backend-v2-token: internal-test-token', $requests[0]['headers'], true), 'Internal token was not attached.');
$assert($requests[0]['connectMs'] === 900 && $requests[0]['totalMs'] === 4200, 'Timeout contract changed.');

$attempts = 0;
$timeout = new BackendV2ApiClient(
    'https://backend.example.test',
    '',
    static function () use (&$attempts): array {
        $attempts++;
        throw new RuntimeException('timeout');
    }
);
try {
    $timeout->request('POST', '/v1/kiosk-pairing-requests', ['device_name' => 'Terminal']);
    throw new RuntimeException('Transport failure should throw an attempt exception.');
} catch (BackendV2ApiAttemptException $error) {
    $assert($attempts === 1, 'Transport failure must never auto-retry.');
    $assert($error->allowsPhpFallback() === false, 'Unknown remote outcome must explicitly forbid PHP fallback.');
    $assert($error->errorCode === 'backend_v2_transport_failure', 'Wrong transport error code.');
}

$blocked = new BackendV2ApiClient(
    'https://backend.example.test',
    '',
    static fn (): array => ['status' => 403, 'body' => '{"ok":false,"error":{"code":"production_hardware_read_only","message":"blocked"}}']
);
$blockedResult = $blocked->request('PATCH', '/v1/clubs/1/kiosks/1', ['name' => 'No']);
$assert($blockedResult['status'] === 403, 'Node HTTP status must be preserved for the proxy.');
$assert(($blockedResult['payload']['error']['code'] ?? null) === 'production_hardware_read_only', 'Node error code must be preserved.');

$preflightAttempts = 0;
$invalid = new BackendV2ApiClient(
    'https://backend.example.test',
    '',
    static function () use (&$preflightAttempts): array {
        $preflightAttempts++;
        return ['status' => 200, 'body' => '{"ok":true}'];
    }
);
try {
    $invalid->request('POST', '/internal/v1/scoring/visit', []);
    throw new RuntimeException('Non-public path should fail pre-transport.');
} catch (InvalidArgumentException) {
}
$assert($preflightAttempts === 0, 'Invalid route must fail before transport.');

echo "BackendV2ApiClient OK\n";
