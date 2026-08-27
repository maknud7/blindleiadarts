const API_ROOT = new URL("../../api/v1/", import.meta.url);

const ROUTES = Object.freeze({
  common: Object.freeze([
    { id: "home", label: "Hjem", hash: "#home", surface: "player", mobile: true },
    { id: "tournaments", label: "Turneringer", hash: "#tournaments", surface: "player", mobile: true },
    { id: "statistics", label: "Statistikk", hash: "#statistics", surface: "player", mobile: true },
    { id: "profile", label: "Min profil", hash: "#profile", surface: "player", mobile: false },
  ]),
  clubAdmin: Object.freeze([
    { id: "overview", label: "Klubboversikt", hash: "#admin/overview", surface: "admin" },
    { id: "tournaments", label: "Turneringsadmin", hash: "#admin/tournaments", surface: "admin" },
    { id: "seasons", label: "Sesonger", hash: "#admin/seasons", surface: "admin" },
    { id: "playerbase", label: "Spillere", hash: "#admin/playerbase", surface: "admin" },
    { id: "players", label: "Medlemmer", hash: "#admin/players", surface: "admin" },
    { id: "kiosks", label: "Utstyr", hash: "#admin/kiosks", surface: "admin" },
    { id: "integrations", label: "Innstillinger", hash: "#admin/integrations", surface: "admin" },
  ]),
  superAdmin: Object.freeze([
    { id: "superadmin", label: "Systemstatus", hash: "#admin/superadmin", surface: "admin" },
  ]),
});

let resolvedToken = null;
let resolvedUser = undefined;
let inFlight = null;
const listeners = new Set();

function token() {
  return localStorage.getItem("bd:token") || "";
}

function isAdmin(user = resolvedUser) {
  return ["club_admin", "super_admin"].includes(String(user?.role || ""));
}

function emit() {
  const detail = snapshot();
  listeners.forEach((listener) => {
    try { listener(detail); } catch { /* consumer error must not break session */ }
  });
  window.dispatchEvent(new CustomEvent("bd:session", { detail }));
}

function clear() {
  localStorage.removeItem("bd:token");
  resolvedToken = "";
  resolvedUser = null;
  inFlight = null;
  emit();
}

async function resolve({ force = false } = {}) {
  const currentToken = token();
  if (!currentToken) {
    resolvedToken = "";
    resolvedUser = null;
    return null;
  }
  if (!force && resolvedToken === currentToken && resolvedUser !== undefined) return resolvedUser;
  if (!force && inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(new URL("auth/me", API_ROOT), {
        headers: { Authorization: `Bearer ${currentToken}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        if (response.status === 401) clear();
        return null;
      }
      resolvedToken = currentToken;
      resolvedUser = payload?.data?.user || null;
      emit();
      return resolvedUser;
    } catch {
      // Keep a valid-looking local session during a temporary network error.
      // Feature requests will surface the actual connection problem later.
      resolvedToken = currentToken;
      if (resolvedUser === undefined) resolvedUser = null;
      return resolvedUser;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function prime(user) {
  resolvedToken = token();
  resolvedUser = user || null;
  emit();
}

function snapshot() {
  return Object.freeze({
    token: token(),
    user: resolvedUser === undefined ? null : resolvedUser,
    resolved: resolvedUser !== undefined,
    isAdmin: isAdmin(),
  });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizeHash(hash = window.location.hash) {
  const value = String(hash || "").replace(/^#/, "").trim();
  if (!value) return "home";
  if (value === "admin") return "admin/overview";
  return value;
}

function route(hash = window.location.hash) {
  const value = normalizeHash(hash);
  if (value.startsWith("admin/")) {
    return { surface: "admin", view: value.slice(6) || "overview", hash: `#${value}` };
  }
  return { surface: "player", view: value || "home", hash: `#${value || "home"}` };
}

function href(surface, view) {
  if (surface === "admin") return `#admin/${view || "overview"}`;
  return `#${view || "home"}`;
}

function menuFor(user = resolvedUser) {
  const items = [...ROUTES.common];
  if (isAdmin(user)) items.push(...ROUTES.clubAdmin);
  if (String(user?.role || "") === "super_admin") items.push(...ROUTES.superAdmin);
  return items;
}

window.BlindleiaApp = Object.freeze({
  routes: ROUTES,
  session: Object.freeze({ token, resolve, prime, clear, snapshot, subscribe, isAdmin }),
  router: Object.freeze({ normalizeHash, route, href }),
  menuFor,
});

export default window.BlindleiaApp;
