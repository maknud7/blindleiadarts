const loaded = new Map();

const sectionModules = Object.freeze({
  players: "./member-onboarding-admin.js?v=20260904-lazy-admin-01",
  integrations: "./payment-settings.js?v=20260904-lazy-admin-01",
  kiosks: "./scolia-admin.js?v=20260904-lazy-admin-01",
});

const canonicalToLocal = Object.freeze({
  club: "overview",
  "tournament-admin": "tournaments",
  members: "players",
  equipment: "kiosks",
  settings: "integrations",
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
  const path = sectionModules[key];
  if (!path) return;

  if (!loaded.has(key)) {
    loaded.set(key, import(new URL(path, import.meta.url).href).catch((error) => {
      loaded.delete(key);
      console.warn(`Adminseksjonen ${key} kunne ikke lastes`, error);
      throw error;
    }));
  }

  try {
    await loaded.get(key);
    // Scolia predates the canonical #admin/equipment route and only polls the
    // old short hashes. Trigger its own refresh button whenever Utstyr opens.
    if (key === "kiosks") {
      window.setTimeout(() => document.getElementById("scoliaRefresh")?.click(), 0);
    }
  } catch {
    // The section module owns its visible error handling after a retry.
  }
}

window.addEventListener("bd:portal-view", (event) => loadSection(event.detail?.target));
window.addEventListener("hashchange", () => loadSection(currentTarget()));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => loadSection(currentTarget()), { once: true });
} else {
  queueMicrotask(() => loadSection(currentTarget()));
}
