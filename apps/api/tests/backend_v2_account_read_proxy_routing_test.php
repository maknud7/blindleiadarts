<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2AccountReadProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2AccountReadProxyApplication(dirname(__DIR__));

foreach ([
    ['GET', '/v1/auth/me'],
    ['GET', '/v1/me/profile'],
    ['GET', '/v1/me/payments'],
    ['GET', '/v1/me/eligibility'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 account reads.");
}

// Shared TEST -> PROD identity is deliberately read-only. Any route that can
// create/touch sessions or mutate identity/profile state must remain outside
// this proxy until identity writes get a dedicated safe cutover.
foreach ([
    ['POST', '/v1/auth/login'],
    ['POST', '/v1/auth/me'],
    ['PUT', '/v1/me/profile'],
    ['PATCH', '/v1/me/profile'],
    ['POST', '/v1/me/password'],
    ['POST', '/v1/tournaments/1/register'],
    ['GET', '/v1/me/dashboard'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must remain outside the account-read proxy.");
}

echo "BackendV2AccountReadProxy routing OK\n";
