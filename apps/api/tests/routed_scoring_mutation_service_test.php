<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringAttemptException;
use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringClient;
use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringRoutingPolicy;
use Blindleia\Dartkiosk\Api\Service\RoutedScoringMutationService;
use Blindleia\Dartkiosk\Api\Service\ScoringMutationPort;

require dirname(__DIR__) . '/bootstrap.php';

final class RecordingPhpScoringPort implements ScoringMutationPort
{
    /** @var array<int,string> */
    public array $calls = [];

    public function startMatch(int $kioskId, string $source = 'manual'): void
    {
        $this->calls[] = "start:$kioskId:$source";
    }

    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void
    {
        $this->calls[] = "visit:$kioskId:$source";
    }

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void
    {
        $this->calls[] = "undo:$kioskId:$source";
    }
}

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$php = new RecordingPhpScoringPort();
$transportCalls = 0;
$client = new BackendV2ScoringClient(
    'https://backend-v2.example.test',
    'unit-test-token',
    static function (string $url, array $headers, string $json, int $connectMs, int $totalMs) use (&$transportCalls): array {
        $transportCalls++;
        return ['status' => 200, 'body' => '{"ok":true,"result":{}}'];
    }
);
$router = new RoutedScoringMutationService(
    new BackendV2ScoringRoutingPolicy('candidate', 'https://backend-v2.example.test', '270'),
    $php,
    $client
);

$router->startMatch(270, 'manual');
$router->recordVisit(270, ['input_mode' => 'sum', 'score' => 60, 'darts_used' => 3], 'manual');
$router->undoLastVisit(270, 'manual');
$assert($transportCalls === 3, 'Allowlisted kiosk must use backend-v2 exactly once per mutation.');
$assert($php->calls === [], 'Allowlisted kiosk must never double-write through PHP.');

$router->recordVisit(477, ['input_mode' => 'sum', 'score' => 45, 'darts_used' => 3], 'manual');
$assert($transportCalls === 3, 'Non-allowlisted kiosk must not contact backend-v2.');
$assert($php->calls === ['visit:477:manual'], 'Non-allowlisted kiosk must remain on PHP.');

$phpFailure = new RecordingPhpScoringPort();
$attempts = 0;
$failingClient = new BackendV2ScoringClient(
    'https://backend-v2.example.test',
    'unit-test-token',
    static function () use (&$attempts): array {
        $attempts++;
        throw new RuntimeException('simulated timeout after possible commit');
    }
);
$failingRouter = new RoutedScoringMutationService(
    new BackendV2ScoringRoutingPolicy('candidate', 'https://backend-v2.example.test', '270'),
    $phpFailure,
    $failingClient
);

$failed = false;
try {
    $failingRouter->recordVisit(270, ['input_mode' => 'sum', 'score' => 100, 'darts_used' => 3], 'scolia');
} catch (BackendV2ScoringAttemptException $error) {
    $failed = true;
    $assert($error->allowsPhpFallback() === false, 'Attempt exception must forbid PHP fallback.');
}
$assert($failed, 'Backend-v2 transport failure must surface as an attempted mutation failure.');
$assert($attempts === 1, 'Backend-v2 mutation must never be automatically retried.');
$assert($phpFailure->calls === [], 'PHP must not run after an attempted backend-v2 mutation.');

$missingClientPhp = new RecordingPhpScoringPort();
$missingClientRouter = new RoutedScoringMutationService(
    new BackendV2ScoringRoutingPolicy('candidate', 'https://backend-v2.example.test', '270'),
    $missingClientPhp,
    null
);
$missingFailed = false;
try {
    $missingClientRouter->startMatch(270, 'manual');
} catch (RuntimeException) {
    $missingFailed = true;
}
$assert($missingFailed, 'Selected backend-v2 route without client must fail closed.');
$assert($missingClientPhp->calls === [], 'Missing backend client must not silently fall back to PHP.');

echo "RoutedScoringMutationService OK\n";
