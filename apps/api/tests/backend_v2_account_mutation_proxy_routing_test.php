<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\BackendV2AccountMutationProxyApplication;

require dirname(__DIR__) . '/bootstrap.php';

$assert = static function (bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
};

$proxy = new BackendV2AccountMutationProxyApplication(dirname(__DIR__));

foreach ([
    ['POST', '/v1/auth/login'],
    ['PUT', '/v1/me/profile'],
    ['PATCH', '/v1/me/profile'],
    ['POST', '/v1/me/password'],
    ['POST', '/v1/auth/password-reset/request'],
    ['POST', '/v1/auth/password-reset/confirm'],
] as [$method, $path]) {
    $assert($proxy->handles($method, $path), "$method $path should route to backend-v2 account mutations.");
}

foreach ([
    ['GET', '/v1/auth/me'],
    ['GET', '/v1/me/profile'],
    ['GET', '/v1/me/payments'],
    ['POST', '/v1/tournaments/1/register'],
    ['POST', '/v1/clubs/1/players'],
] as [$method, $path]) {
    $assert(!$proxy->handles($method, $path), "$method $path must remain outside the account-mutation proxy.");
}

echo "BackendV2AccountMutationProxy routing OK\n";
