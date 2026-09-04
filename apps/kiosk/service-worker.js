const SHELL_CACHE = "bd-kiosk-shell-v42";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./pairing.css",
  "./kiosk-polish.css",
  "./brand-light.css",
  "./tablet-portrait.css",
  "./kiosk-ux-v2.css",
  "./kiosk-brand-v3.css",
  "./kiosk-fine-polish.css",
  "./operations-runtime.css",
  "./mobile.css",
  "./club-tablet-ux.css",
  "./state-visibility-fix.css",
  "./tablet-action-row-fix.css",
  "./prod-test-entry.css",
  "./scolia-live-ux.css",
  "../packages/ui-assets/brand-tokens.css",
  "../packages/ui-assets/blindleia-system.css",
  "./realtime-refresh-compat.js",
  "./app.js",
  "./pairing-runtime.js",
  "./pairing-canonical-link.js",
  "./operations-runtime.js",
  "./scolia-runtime.js",
  "./scolia-live-ux.js",
  "./scolia-fallback-manual.js",
  "./admin-mode.js",
  "./test-mode.js",
  "./direct-test-handoff.js",
  "./prod-test-entry.js",
  "./kiosk-ux-v2.js",
  "./kiosk-brand-v3.js",
  "./kiosk-fine-polish.js",
  "./terminal-refresh.js",
  "./install.js",
  "./manifest.webmanifest",
  "../static/club-logos/blindleia-dartklubb-logo.svg",
  "../static/club-logos/blindleia-dartklubb-logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("bd-kiosk-shell-") && key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
    }
    return response;
  } catch {
    return (await caches.match(request)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Scoring/runtime APIs are always network-only. The service worker must never
  // manufacture, replay or cache mutable match state.
  if (url.pathname.includes("/api/") || url.pathname.endsWith(".php")) return;
  if (url.origin !== self.location.origin) return;

  // The kiosk is operational software, not a static brochure. HTML, JavaScript
  // and CSS must prefer the deployed version whenever the terminal is online.
  // Cache remains an offline fallback only.
  if (request.mode === "navigate" || ["script", "style"].includes(request.destination)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && ["image", "manifest"].includes(request.destination)) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
      }
      return response;
    }))
  );
});
