const loaded = new Map();

const sectionModules = Object.freeze({
  overview: [
    "./club-live-admin.js?v=20260920-admin-perf-01",
  ],
  players: [
    "./member-onboarding-admin.js?v=20260920-admin-perf-01",
  ],
  playerbase: [
    "./player-identity-admin.js?v=20260920-admin-perf-01",
    "./player-member-link-admin.js?v=20260920-admin-perf-01",
  ],
  integrations: [
    "./payment-settings.js?v=20260920-admin-perf-01",
  ],
  kiosks: [
    "./pairing-claim.js?v=20260920-admin-perf-01",
  ],
  superadmin: [
    "./health-tracker.js?v=20260920-admin-perf-01",
    "./activity-admin.js?v=20260920-admin-perf-01",
    "./superadmin-identity-audit.js?v=20260920-admin-perf-01",
  ],
});

const canonicalToLocal = Object.freeze({
  club: "overview",
  "tournament-admin": "tournaments",
  seasons: "seasons",
  playerbase: "playerbase",
  members: "players",
  equipment: "kiosks",
  settings: "integrations",
  superadmin: "superadmin",
});

function normalizeTarget(value) {
  let target = String(value || "").replace(/^#/, "").trim();
  if (target.startsWith("admin/")) target = target.slice(6);
  return canonicalToLocal[target] || target;
}

function currentTarget() {
  return normalizeTarget(document.body.dataset.portalActive || window.location.hash);
}

async function loadSection(target) {
  const key = normalizeTarget(target);
  const paths = sectionModules[key];
  if (!paths?.length) return;

  if (!loaded.has(key)) {
    loaded.set(key, Promise.all(paths.map((path) => import(new URL(path, import.meta.url).href))).catch((error) => {
      loaded.delete(key);
      console.warn(`Adminseksjonen ${key} kunne ikke lastes`, error);
      throw error;
    }));
  }

  try {
    await loaded.get(key);
    if (key === "kiosks") {
      window.setTimeout(() => document.getElementById("scoliaRefresh")?.click(), 0);
    }
  } catch {
    // Section modules own their visible error handling after a retry.
  }
}

window.addEventListener("bd:portal-view", (event) => loadSection(event.detail?.target));
window.addEventListener("hashchange", () => loadSection(currentTarget()));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => loadSection(currentTarget()), { once: true });
} else {
  queueMicrotask(() => loadSection(currentTarget()));
}
