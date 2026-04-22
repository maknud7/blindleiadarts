<?php

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $connectorBasePath = dirname(__DIR__, 1) . '/packages/connectors/src/';

    if (!is_dir($connectorBasePath)) {
        $connectorBasePath = dirname(__DIR__, 2) . '/packages/connectors/src/';
    }

    $prefixes = [
        'Blindleia\\Dartkiosk\\Api\\' => __DIR__ . '/src/',
        'Blindleia\\Dartkiosk\\Connectors\\' => $connectorBasePath,
    ];

    foreach ($prefixes as $prefix => $basePath) {
        if (!str_starts_with($class, $prefix)) {
            continue;
        }

        $relativeClass = substr($class, strlen($prefix));
        $path = $basePath . str_replace('\\', '/', $relativeClass) . '.php';

        if (is_file($path)) {
            require $path;
        }

        return;
    }
});
