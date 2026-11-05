const loaded = new Map();
const loadedModules = new Map();
const failedModuleAttempts = new Map();

function importOnce(path) {
  if (!loadedModules.has(path)) {
    const attempt = failedModuleAttempts.get(path) || 0;
    const url = new URL(path, import.meta.url);
    // A browser may cache a failed dynamic import by URL. Retry only that
    // module at a new URL, leaving successfully loaded modules untouched.
    if (attempt) url.searchParams.set("moduleRetry", String(attempt));
    loadedModules.set(path, import(url.href).catch((error) => {
      loadedModules.delete(path);
      failedModuleAttempts.set(path, attempt + 1);
      throw error;
    }));
  }
  return loadedModules.get(path);
}
// Opening Utstyr repeatedly must never flood Scolia reads or block navigation.
const equipmentRefreshedForClub = new Set();

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
    "./pairing-claim.js?v=20261104-terminal-ux-freeze-01",
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
    loaded.set(key, Promise.all(paths.map(importOnce)).catch((error) => {
      loaded.delete(key);
      console.warn(`Adminseksjonen ${key} kunne ikke lastes`, error);
      throw error;
    }));
  }

  try {
    await loaded.get(key);
    if (key === "kiosks" && currentTarget() === "kiosks") {
      const clubKey = String(localStorage.getItem("bd:selectedClubId") || "default");
      const adminVisible = !document.getElementById("adminApp")?.classList.contains("hidden");
      const refreshButton = document.getElementById("scoliaRefresh");
      if (adminVisible && refreshButton && !equipmentRefreshedForClub.has(clubKey)) {
        equipmentRefreshedForClub.add(clubKey);
        window.setTimeout(() => {
          if (currentTarget() === "kiosks" && !document.getElementById("adminApp")?.classList.contains("hidden")) {
            refreshButton.click();
          }
        }, 0);
      }
    }
  } catch {
    // A failed dynamic import is not handled by the module, because it never
    // executed. Give members a visible retry instead of an endless "Laster".
    if (key === "players") {
      const status = document.getElementById("memberRegistryStatus");
      if (status && !document.querySelector("#players .member-access-block")) {
        status.classList.remove("hidden");
        status.removeAttribute("hidden");
        const message = document.createElement("span");
        message.textContent = "Medlemsregisteret kunne ikke åpnes. ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button secondary";
        retry.textContent = "Prøv igjen";
        retry.addEventListener("click", () => loadSection("players"));
        status.replaceChildren(message, retry);
      }
    }
  }
}

window.addEventListener("bd:portal-view", (event) => loadSection(event.detail?.target));
window.addEventListener("hashchange", () => loadSection(currentTarget()));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => loadSection(currentTarget()), { once: true });
} else {
  queueMicrotask(() => loadSection(currentTarget()));
}
