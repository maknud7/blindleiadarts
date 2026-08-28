<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Support\Config;

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');
header('Service-Worker-Allowed: /');

$config = Config::load(__DIR__);
$env = strtolower($config->appEnv()) === 'test' ? 'test' : 'prod';
$releaseSha = 'dev';
$releasePath = dirname(__DIR__) . '/release.json';
if (is_file($releasePath)) {
    $release = json_decode((string) file_get_contents($releasePath), true);
    if (is_array($release) && is_string($release['sha'] ?? null) && trim($release['sha']) !== '') {
        $releaseSha = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $release['sha']) ?: 'dev';
    }
}
$cacheName = sprintf('blindleia-pwa-%s-%s', $env, substr($releaseSha, 0, 12));
$appShell = [
    '/',
    '/index.html',
    '/api/pwa-manifest.php',
    '/player/styles.css',
    '/player/player-ux.css',
    '/player/account-pwa.css',
    '/player/pwa-install.js',
    '/player/player-now.js',
    '/packages/ui-assets/brand-tokens.css',
    '/packages/ui-assets/blindleia-system.css',
    '/packages/ui-assets/app-core.js',
    '/static/club-logos/blindleia-dartklubb-logo.svg',
    '/static/club-logos/blindleia-dartklubb-logo.png',
];
if ($env === 'test') {
    $appShell[] = '/static/club-logos/blindleia-dartklubb-test.svg';
}

$envJson = json_encode($env, JSON_THROW_ON_ERROR);
$cacheJson = json_encode($cacheName, JSON_THROW_ON_ERROR);
$shellJson = json_encode($appShell, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

echo <<<JS
const APP_ENV = {$envJson};
const CACHE_NAME = {$cacheJson};
const APP_SHELL = {$shellJson};
const CACHE_PREFIX = "blindleia-pwa-";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => undefined)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isPrivateRequest(request, url) {
  return url.pathname.includes("/api/") || request.headers.has("Authorization");
}

function isCacheableAsset(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (isPrivateRequest(request, url)) return false;
  return ["style", "script", "image", "font", "manifest"].includes(request.destination)
    && (url.pathname.includes("/player/") || url.pathname.includes("/packages/ui-assets/") || url.pathname.includes("/static/"));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isPrivateRequest(request, url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => (await caches.match("/index.html")) || caches.match("/"))
    );
    return;
  }

  if (!isCacheableAsset(request, url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
JS;
