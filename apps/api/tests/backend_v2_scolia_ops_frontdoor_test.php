<?php

declare(strict_types=1);

$router = file_get_contents(__DIR__ . '/../scolia-bridge-router.php');
$health = file_get_contents(__DIR__ . '/../scolia-health.php');
if (!is_string($router) || !is_string($health)) {
    fwrite(STDERR, "Could not read Scolia operation frontdoors.\n");
    exit(1);
}

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        fwrite(STDERR, $message . "\n");
        exit(1);
    }
};

$assert(str_contains($router, "backendV2ScoliaRoutingMode() === 'node'"), 'Bridge router must use the explicit Scolia Node routing gate.');
$assert(str_contains($router, "'/v1/scolia/bridge/router'"), 'Bridge router must call the backend-v2 router endpoint.');
$assert(str_contains($router, "'x-scolia-bridge-secret' => \$providedSecret"), 'Bridge router must validate and forward the incoming bridge secret.');
$assert(strpos($router, "backendV2ScoliaRoutingMode() === 'node'") < strpos($router, 'new Database($config)'), 'Bridge router must decide Node routing before opening the PHP DB path.');
$assert(str_contains($health, "backendV2ScoliaRoutingMode() === 'node'"), 'Health endpoint must use the explicit Scolia Node routing gate.');
$assert(str_contains($health, "'/v1/scolia/health'"), 'Health endpoint must call the backend-v2 health endpoint.');
$assert(strpos($health, "backendV2ScoliaRoutingMode() === 'node'") < strpos($health, 'new Database($config)'), 'Health must decide Node routing before opening the PHP DB path.');
$assert(!str_contains($router, 'allowsPhpFallback'), 'Bridge router must never fall through to PHP after a Node attempt.');
$assert(!str_contains($health, 'allowsPhpFallback'), 'Health must never fall through to PHP after a Node attempt.');

echo "Backend v2 Scolia ops frontdoor contract OK\n";
