<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Service\BackendV2ScoringRoutingPolicy;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$route = static function (string $mode, string $url, string $allowlist, string $kioskId): string {
    return (new BackendV2ScoringRoutingPolicy($mode, $url, $allowlist))->routeForKiosk($kioskId);
};

$assert(
    $route('php', 'https://backend.example.test', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Default PHP mode must never select the backend-v2 candidate.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '7, 12', '7') === BackendV2ScoringRoutingPolicy::ROUTE_CANDIDATE,
    'Explicitly allowlisted kiosk should be candidate-eligible.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '7,12', '8') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Non-allowlisted kiosk must stay on PHP.'
);
$assert(
    $route('backend-v2', 'https://backend.example.test', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Unknown routing mode must fail closed to PHP.'
);
$assert(
    $route('candidate', '', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Candidate mode without a base URL must fail closed.'
);
$assert(
    $route('candidate', 'http://backend.example.test', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Candidate base URL must use HTTPS.'
);
$assert(
    $route('candidate', 'https://user:pass@backend.example.test', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Candidate base URL must not contain credentials.'
);
$assert(
    $route('candidate', 'https://backend.example.test#fragment', '7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Candidate base URL must not contain a fragment.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Empty allowlist must fail closed.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '7,not-an-id,9', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'One malformed allowlist item must invalidate the complete candidate config.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '7,*', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Wildcard allowlists must be rejected.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '07,7', '7') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Leading-zero allowlist IDs must invalidate the config.'
);
$assert(
    $route('candidate', 'https://backend.example.test', '7', '07') === BackendV2ScoringRoutingPolicy::ROUTE_PHP,
    'Leading-zero kiosk IDs must not match.'
);

$bigint = '9223372036854775808';
$assert(
    $route('candidate', 'https://backend.example.test', $bigint, $bigint) === BackendV2ScoringRoutingPolicy::ROUTE_CANDIDATE,
    'BIGINT identifiers beyond PHP signed integer range must compare as exact decimal strings.'
);

echo "BackendV2ScoringRoutingPolicy OK\n";
