<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

use Blindleia\Dartkiosk\Api\BackendV2PaymentSettingsProxyApplication;

$app = new BackendV2PaymentSettingsProxyApplication(dirname(__DIR__));

$yes = [
    ['GET', '/v1/clubs/1/payment-settings'],
    ['PUT', '/v1/clubs/1/payment-settings'],
    ['PATCH', '/v1/clubs/90071992547409931/payment-settings'],
];
foreach ($yes as [$method, $path]) {
    if (!$app->handles($method, $path)) {
        fwrite(STDERR, "Expected payment-settings frontdoor to handle {$method} {$path}\n");
        exit(1);
    }
}

$no = [
    ['POST', '/v1/clubs/1/payment-settings'],
    ['DELETE', '/v1/clubs/1/payment-settings'],
    ['GET', '/v1/clubs/1/payment-settings/other'],
    ['GET', '/v1/clubs/1/activity'],
    ['GET', '/v1/clubs/payment-settings'],
];
foreach ($no as [$method, $path]) {
    if ($app->handles($method, $path)) {
        fwrite(STDERR, "Unexpected payment-settings frontdoor capture for {$method} {$path}\n");
        exit(1);
    }
}

echo "BackendV2PaymentSettingsProxy routing OK\n";
