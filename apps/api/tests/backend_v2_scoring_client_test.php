<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringAttemptException;
use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringClient;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$requests = [];
$successTransport = static function (string $url, array $headers, string $json, int $connectMs, int $totalMs) use (&$requests): array {
    $requests[] = compact('url', 'headers', 'json', 'connectMs', 'totalMs');
    return ['status' => 200, 'body' => '{"ok":true,"result":{"match_id":"9007199254740993"}}'];
};

$client = new BackendV2ScoringClient(
    'https://blindleia-backend-v2-readonly.onrender.com',
    'test-token',
    $successTransport,
    1200,
    4500
);
$bigint = '9223372036854775808';
$result = $client->startMatch($bigint, 'manual');
$assert(($result['match_id'] ?? null) === '9007199254740993', 'Success result must preserve decimal string IDs.');
$assert(count($requests) === 1, 'Exactly one transport attempt is allowed per client mutation call.');
$assert(str_ends_with($requests[0]['url'], '/internal/v1/scoring/start-match'), 'Start endpoint is wrong.');
$decoded = json_decode($requests[0]['json'], true, 512, JSON_THROW_ON_ERROR);
$assert(($decoded['kiosk_id'] ?? null) === $bigint, 'Kiosk BIGINT must remain an exact decimal string.');
$assert(in_array('x-bd-backend-v2-token: test-token', $requests[0]['headers'], true), 'Internal token header is missing.');
$assert($requests[0]['connectMs'] === 1200 && $requests[0]['totalMs'] === 4500, 'Configured timeouts were not passed to transport.');

$attempts = 0;
$timeoutClient = new BackendV2ScoringClient(
    'https://backend.example.test',
    'test-token',
    static function () use (&$attempts): array {
        $attempts++;
        throw new RuntimeException('timeout');
    }
);
try {
    $timeoutClient->recordVisit('7', ['score' => 60], 'manual');
    throw new RuntimeException('Transport timeout should have thrown.');
} catch (BackendV2ScoringAttemptException $error) {
    $assert($attempts === 1, 'Transport failures must never auto-retry the mutation.');
    $assert($error->allowsPhpFallback() === false, 'Unknown outcome must explicitly forbid PHP fallback.');
    $assert($error->backendErrorCode() === 'backend_v2_transport_failure', 'Transport failure code is wrong.');
}

foreach ([403, 500] as $status) {
    $httpClient = new BackendV2ScoringClient(
        'https://backend.example.test',
        'test-token',
        static fn (): array => [
            'status' => $status,
            'body' => '{"ok":false,"error":{"code":"blocked","message":"blocked"}}',
        ]
    );
    try {
        $httpClient->undoLastVisit('9', 'manual');
        throw new RuntimeException("HTTP $status should have thrown.");
    } catch (BackendV2ScoringAttemptException $error) {
        $assert($error->httpStatus() === $status, "HTTP $status status was not preserved.");
        $assert($error->allowsPhpFallback() === false, "HTTP $status must not permit fallback after an attempted mutation.");
    }
}

$invalidResponseClient = new BackendV2ScoringClient(
    'https://backend.example.test',
    'test-token',
    static fn (): array => ['status' => 200, 'body' => '<html>not json</html>']
);
try {
    $invalidResponseClient->startMatch('11', 'api');
    throw new RuntimeException('Invalid backend response should have thrown.');
} catch (BackendV2ScoringAttemptException $error) {
    $assert($error->allowsPhpFallback() === false, 'Invalid response after transport must not permit PHP fallback.');
}

$preflightAttempts = 0;
$invalidInputClient = new BackendV2ScoringClient(
    'https://backend.example.test',
    'test-token',
    static function () use (&$preflightAttempts): array {
        $preflightAttempts++;
        return ['status' => 200, 'body' => '{"ok":true,"result":{}}'];
    }
);
foreach ([['07', 'manual'], ['7', 'unknown']] as [$kioskId, $source]) {
    try {
        $invalidInputClient->startMatch($kioskId, $source);
        throw new RuntimeException('Invalid pre-transport input should have thrown.');
    } catch (InvalidArgumentException) {
        // Safe: request was never attempted, so no ambiguous commit exists.
    }
}
$assert($preflightAttempts === 0, 'Invalid input must fail before any backend-v2 attempt.');

echo "BackendV2ScoringClient OK\n";
