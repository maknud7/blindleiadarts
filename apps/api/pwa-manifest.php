<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/manifest+json; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');

$config = Config::load(__DIR__);
$isTest = strtolower($config->appEnv()) === 'test';

$manifest = [
    'id' => $isTest ? '/blindleia-darts-test' : '/blindleia-darts',
    'name' => $isTest ? 'Blindleia Darts TEST' : 'Blindleia Darts',
    'short_name' => $isTest ? 'Blindleia TEST' : 'Blindleia',
    'description' => $isTest
        ? 'Testversjon av spillerportalen for Blindleia Dartklubb.'
        : 'Spillerportal for Blindleia Dartklubb – turneringer, kampstatus, statistikk og medlemskap.',
    'lang' => 'nb-NO',
    'start_url' => $isTest ? '/?pwa=test#home' : '/#home',
    'scope' => '/',
    'display' => 'standalone',
    'display_override' => ['standalone', 'minimal-ui'],
    'orientation' => 'any',
    'background_color' => $isTest ? '#fff8d8' : '#f3f6fb',
    'theme_color' => $isTest ? '#f3c23c' : '#0b2b50',
    'categories' => ['sports', 'productivity'],
    'icons' => $isTest ? [
        [
            'src' => '/static/club-logos/blindleia-dartklubb-test.svg',
            'sizes' => 'any',
            'type' => 'image/svg+xml',
            'purpose' => 'any maskable',
        ],
        [
            'src' => '/static/club-logos/blindleia-dartklubb-logo.png',
            'sizes' => '1024x1024',
            'type' => 'image/png',
            'purpose' => 'any',
        ],
    ] : [
        [
            'src' => '/static/club-logos/blindleia-dartklubb-logo.svg',
            'sizes' => 'any',
            'type' => 'image/svg+xml',
            'purpose' => 'any',
        ],
        [
            'src' => '/static/club-logos/blindleia-dartklubb-logo.png',
            'sizes' => '1024x1024',
            'type' => 'image/png',
            'purpose' => 'any',
        ],
    ],
    'shortcuts' => [
        ['name' => 'Hjem', 'url' => '/#home'],
        ['name' => 'Turneringer', 'url' => '/#tournaments'],
        ['name' => 'Statistikk', 'url' => '/#statistics'],
    ],
];

echo json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
