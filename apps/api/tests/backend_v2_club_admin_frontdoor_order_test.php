<?php

declare(strict_types=1);

$index = file_get_contents(__DIR__ . '/../index.php');
if (!is_string($index)) {
    fwrite(STDERR, "Could not read API index.\n");
    exit(1);
}

$frontdoor = strpos($index, '$clubAdminV2 = new BackendV2ClubAdminProxyApplication');
$legacy = strpos($index, '$app = new Application(__DIR__)');
if ($frontdoor === false || $legacy === false || $frontdoor >= $legacy) {
    fwrite(STDERR, "Club-admin Node frontdoor must run before the generic legacy Application.\n");
    exit(1);
}

$generator = file_get_contents(dirname(__DIR__, 3) . '/infra/deploy/generate_api_config.php');
if (!is_string($generator)
    || !str_contains($generator, '$defaultBackendV2ClubAdminRoutingMode = $isTest ? \'node\' : \'php\';')) {
    fwrite(STDERR, "Club-admin routing must default TEST=node and non-TEST=php.\n");
    exit(1);
}

echo "BackendV2ClubAdmin frontdoor order OK\n";
