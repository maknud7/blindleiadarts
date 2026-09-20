const VERSION = "20260920-player-perf-01";
const loaded = new Map();

const sectionModules = Object.freeze({
  home: [
    "./checkin-mutation-guard.js",
    "./player-ux.js",
    "./checkin-runtime.js",
    "./player-breaks.js",
    "./player-break-now.js",
    "./home-dashboard-ux.js",
    "./player-state-sync.js",
  ],
  tournaments: [
    "./checkin-mutation-guard.js",
    "./checkin-runtime.js",
    "./tournament-hub.js",
    "./tournament-registration-ux.js",
    "./player-tournament-enhancements.js",
    "./player-state-sync.js",
  ],
  statistics: [
    "./portal-content.js",
    "./match-detail-ux.js",
    "./portal-playoffs.js",
    "./statistics-ux.js",
    "./tournament-elo-summary.js",
    "./elo-history-exact.js",
  ],
  profile: [
    "./member-account.js",
    "./account-onboarding-ux.js",
  ],
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

async function loadSection(target) {
  const key = normalizeTarget(target);
  const modules = sectionModules[key];
  if (!modules?.length) return;

  if (!loaded.has(key)) {
    loaded.set(key, (async () => {
      for (const path of modules) {
        await import(moduleUrl(path));
      }
      window.dispatchEvent(new CustomEvent("bd:player-section-ready", { detail: { target: key } }));
    })().catch((error) => {
      loaded.delete(key);
      console.warn(`Spillerseksjonen ${key} kunne ikke lastes`, error);
      throw error;
    }));
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
