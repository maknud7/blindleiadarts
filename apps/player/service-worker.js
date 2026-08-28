const CACHE_NAME = "blindleia-player-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles.css",
  "./player-ux.css",
  "./account-pwa.css",
  "./player-now.js",
  "../static/club-logos/blindleia-dartklubb-logo.svg",
  "../static/club-logos/blindleia-dartklubb-logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("blindleia-player-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isCacheableAsset(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (url.pathname.includes("/api/")) return false;
  if (request.headers.has("Authorization")) return false;
  return ["style", "script", "image", "font", "manifest"].includes(request.destination)
    && (url.pathname.includes("/player/") || url.pathname.includes("/packages/ui-assets/") || url.pathname.includes("/static/"));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.pathname.includes("/api/") || request.headers.has("Authorization")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" && url.origin === self.location.origin && url.pathname.includes("/player")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (!isCacheableAsset(request, url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
