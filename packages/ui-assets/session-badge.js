const SESSION_URL = new URL("../../api/v1/activity/session", import.meta.url);
const BADGE_ID = "bd-session-badge";
const REFRESH_MS = 5 * 60 * 1000;
let refreshTimer = null;
let lastToken = null;
let lastSession = null;
let accountObserver = null;

function token() {
  return window.BlindleiaApp?.session?.token?.() || localStorage.getItem("bd:token") || "";
}

function ensureStyle() {
  if (document.getElementById("bd-session-badge-style")) return;
  const style = document.createElement("style");
  style.id = "bd-session-badge-style";
  style.textContent = `
#${BADGE_ID}{display:block;width:max-content;max-width:100%;margin:2px 0 0;padding:0;border:0;background:transparent!important;box-shadow:none!important;color:rgba(184,203,224,.46);font:600 9px/1.2 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.015em;text-align:left;cursor:pointer;user-select:none;-webkit-user-select:none}
#${BADGE_ID}:hover,#${BADGE_ID}:focus-visible{color:rgba(220,232,244,.78);outline:none}
#${BADGE_ID} .bd-session-label{font-weight:500;opacity:.82}
#${BADGE_ID} .bd-session-value{font-weight:650;font-variant-numeric:tabular-nums}
#${BADGE_ID}.bd-session-copied{color:rgba(220,232,244,.9)}
#${BADGE_ID}.bd-session-copied::after{content:" · kopiert";font-weight:500;opacity:.8}
.unified-sidebar-account #${BADGE_ID},#adminSidebarAccount #${BADGE_ID}{position:static!important;inset:auto!important;z-index:auto!important}
@media(max-width:760px){#${BADGE_ID}{font-size:8px;margin-top:1px}}
`;
  document.head.appendChild(style);
}

function accountHost() {
  return document.querySelector(".unified-sidebar-account > div")
    || document.querySelector("#adminSidebarAccount > div");
}

function removeBadge() {
  document.getElementById(BADGE_ID)?.remove();
}

function installAccountObserver() {
  if (accountObserver) return;
  const root = document.querySelector(".portal-menu") || document.body;
  if (!root) return;
  accountObserver = new MutationObserver(() => {
    if (!lastSession || document.getElementById(BADGE_ID)) return;
    renderSession(lastSession);
  });
  accountObserver.observe(root, { childList: true, subtree: true });
}

function renderSession(session) {
  const id = Number(session?.id || 0);
  if (!id) {
    lastSession = null;
    removeBadge();
    return;
  }

  lastSession = session;
  ensureStyle();
  installAccountObserver();

  const host = accountHost();
  if (!host) {
    window.setTimeout(() => {
      if (lastSession && !document.getElementById(BADGE_ID)) renderSession(lastSession);
    }, 180);
    return;
  }

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
        // The reference remains visible for screenshots and manual copy.
      }
    });
  }

  badge.dataset.sessionId = String(id);
  badge.innerHTML = `<span class="bd-session-label">sesjon</span> <span class="bd-session-value">#${id}</span>`;
  if (badge.parentElement !== host) host.appendChild(badge);
}

async function refreshSession({ force = false } = {}) {
  const auth = token();
  if (!auth) {
    lastToken = null;
    lastSession = null;
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
      lastSession = null;
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
window.addEventListener("bd:portal-view", () => {
  if (lastSession) window.setTimeout(() => renderSession(lastSession), 0);
});
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
