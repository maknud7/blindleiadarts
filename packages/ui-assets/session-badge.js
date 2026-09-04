const SESSION_URL = new URL("../../api/v1/activity/session", import.meta.url);
const BADGE_ID = "bd-session-badge";
const REFRESH_MS = 5 * 60 * 1000;
let refreshTimer = null;
let lastToken = null;

function token() {
  return window.BlindleiaApp?.session?.token?.() || localStorage.getItem("bd:token") || "";
}

function isTestEnvironment() {
  return document.documentElement.dataset.appEnv === "test"
    || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || new URLSearchParams(window.location.search).get("pwa") === "test";
}

function ensureStyle() {
  if (document.getElementById("bd-session-badge-style")) return;
  const style = document.createElement("style");
  style.id = "bd-session-badge-style";
  style.textContent = `
#${BADGE_ID}{position:fixed;left:10px;bottom:10px;z-index:118;display:inline-flex;align-items:center;gap:5px;max-width:calc(100vw - 20px);padding:5px 8px;border:1px solid rgba(12,35,64,.16);border-radius:999px;background:rgba(255,255,255,.92);box-shadow:0 2px 10px rgba(12,35,64,.10);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#52667e;font:700 10px/1.15 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.01em;cursor:pointer;user-select:none;-webkit-user-select:none}
#${BADGE_ID}:hover{background:#fff;color:#0c2340}
#${BADGE_ID}[data-test="1"]{border-color:#d8aa18;background:rgba(255,248,216,.96);color:#6b5000}
#${BADGE_ID} .bd-session-label{font-weight:600;opacity:.82}
#${BADGE_ID} .bd-session-value{font-weight:850;font-variant-numeric:tabular-nums}
#${BADGE_ID}.bd-session-copied::after{content:"Kopiert";position:absolute;left:0;bottom:calc(100% + 5px);padding:4px 7px;border-radius:7px;background:#0c2340;color:#fff;font-size:9px;white-space:nowrap;box-shadow:0 2px 8px rgba(12,35,64,.16)}
@media(max-width:760px){#${BADGE_ID}{bottom:calc(var(--unified-mobile-bar,72px) + env(safe-area-inset-bottom) + 7px);left:8px;z-index:119;padding:4px 7px;font-size:9px}}
`;
  document.head.appendChild(style);
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

function renderSession(session) {
  const id = Number(session?.id || 0);
  if (!id) {
    removeBadge();
    return;
  }

  ensureStyle();
  let badge = document.getElementById(BADGE_ID);
  if (!badge) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.id = BADGE_ID;
    badge.setAttribute("aria-label", "Kopier sesjonsnummer");
    badge.title = "Klikk for å kopiere sesjonsnummeret";
    badge.addEventListener("click", async () => {
      const value = badge.dataset.sessionId ? `#${badge.dataset.sessionId}` : "";
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        badge.classList.add("bd-session-copied");
        window.setTimeout(() => badge.classList.remove("bd-session-copied"), 1200);
      } catch {
        // Badge still remains useful for screenshots/manual copy.
      }
    });
    (document.body || document.documentElement).appendChild(badge);
  }

  badge.dataset.sessionId = String(id);
  badge.dataset.test = isTestEnvironment() ? "1" : "0";
  badge.innerHTML = `<span class="bd-session-label">Sesjon</span><span class="bd-session-value">#${id}</span>`;
}

async function refreshSession({ force = false } = {}) {
  const auth = token();
  if (!auth) {
    lastToken = null;
    removeBadge();
    return;
  }
  if (!force && auth === lastToken && document.getElementById(BADGE_ID)) return;
  lastToken = auth;

  try {
    const response = await fetch(SESSION_URL, {
      headers: { Authorization: `Bearer ${auth}` },
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      removeBadge();
      return;
    }
    if (!response.ok || !payload?.ok) return;
    renderSession(payload?.data?.session || null);
  } catch {
    // Session marker is diagnostic convenience and must never affect the portal.
  }
}

function scheduleRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => refreshSession({ force: true }), REFRESH_MS);
}

window.addEventListener("bd:session", () => refreshSession({ force: true }));
window.addEventListener("storage", (event) => {
  if (event.key === "bd:token") refreshSession({ force: true });
});
window.addEventListener("focus", () => refreshSession({ force: true }));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => refreshSession({ force: true }), { once: true });
} else {
  refreshSession({ force: true });
}
scheduleRefresh();
