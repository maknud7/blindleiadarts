const VERSION = "20260920-player-perf-02";
const loaded = new Map();
const deferredLoaded = new Set();

const sectionStyles = Object.freeze({
  statistics: [
    "./statistics-desktop-match-cards.css",
    "./elo-tournament-history.css",
  ],
  profile: [
    "./profile-v2.css",
    "./account-pwa.css",
  ],
});

const sectionModules = Object.freeze({
  home: {
    critical: [
      "./checkin-mutation-guard.js",
      "./player-ux.js",
      "./checkin-runtime.js",
    ],
    deferred: [
      "./player-breaks.js",
      "./player-break-now.js",
      "./home-dashboard-ux.js",
      "./player-state-sync.js",
    ],
  },
  tournaments: {
    critical: [
      "./checkin-runtime.js",
      "./tournament-hub.js",
      "./tournament-registration-ux.js",
    ],
    deferred: [
      "./player-tournament-enhancements.js",
      "./player-state-sync.js",
    ],
  },
  statistics: {
    critical: [
      "./portal-content.js",
      "./match-detail-ux.js",
      "./portal-playoffs.js",
      "./statistics-ux.js",
      "./tournament-elo-summary.js",
      "./elo-history-exact.js",
    ],
    deferred: [],
  },
  profile: {
    critical: [
      "./member-account.js",
      "./account-onboarding-ux.js",
    ],
    deferred: [],
  },
});

function normalizeTarget(value) {
  const target = String(value || "").replace(/^#/, "").trim();
  if (!target || target === "player") return "home";
  return target.startsWith("player/") ? target.slice(7) || "home" : target;
}

function currentTarget() {
  return normalizeTarget(document.body.dataset.portalActive || window.location.hash || document.body.dataset.portalDefault || "home");
}

function moduleUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set("v", VERSION);
  return url.href;
}

function ensureStyles(key) {
  for (const path of sectionStyles[key] || []) {
    const href = moduleUrl(path);
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === href)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
}

async function importSequence(paths) {
  for (const path of paths || []) {
    await import(moduleUrl(path));
  }
}

function scheduleDeferred(key, paths) {
  if (!paths?.length || deferredLoaded.has(key)) return;
  deferredLoaded.add(key);

  const run = () => {
    if (currentTarget() !== key) {
      deferredLoaded.delete(key);
      return;
    }
    importSequence(paths)
      .then(() => window.dispatchEvent(new CustomEvent("bd:player-section-deferred-ready", { detail: { target: key } })))
      .catch((error) => {
        deferredLoaded.delete(key);
        console.warn(`Sekundære spillerfunksjoner for ${key} kunne ikke lastes`, error);
      });
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 700 });
  } else {
    window.setTimeout(run, 120);
  }
}

async function loadSection(target) {
  const key = normalizeTarget(target);
  const config = sectionModules[key];
  if (!config) return;
  ensureStyles(key);

  if (!loaded.has(key)) {
    loaded.set(key, importSequence(config.critical).then(() => {
      window.dispatchEvent(new CustomEvent("bd:player-section-ready", { detail: { target: key } }));
      scheduleDeferred(key, config.deferred);
    }).catch((error) => {
      loaded.delete(key);
      console.warn(`Spillerseksjonen ${key} kunne ikke lastes`, error);
      throw error;
    }));
  } else {
    scheduleDeferred(key, config.deferred);
  }

  return loaded.get(key);
}

window.addEventListener("bd:portal-view", (event) => {
  loadSection(event.detail?.target).catch(() => undefined);
});
window.addEventListener("hashchange", () => {
  loadSection(currentTarget()).catch(() => undefined);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadSection(currentTarget()).catch(() => undefined);
  }, { once: true });
} else {
  queueMicrotask(() => loadSection(currentTarget()).catch(() => undefined));
}
