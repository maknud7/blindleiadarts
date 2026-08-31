const STYLE_ID = "bdUserGuideAccessStyles";
const SURFACE = document.body.dataset.bdSurface === "admin" || document.body.dataset.portalDefault === "overview" ? "admin" : "player";
const app = window.BlindleiaApp;

// Guide access follows the authenticated product role. New guide topics are deny-by-default:
// they must be explicitly added here when the guide is changed.
const TOPIC_ACCESS = Object.freeze({
  player: Object.freeze({
    activate: ["player", "club_admin", "super_admin"],
    signup: ["player", "club_admin", "super_admin"],
    "follow-tournament": ["player", "club_admin", "super_admin"],
    "match-card": ["player", "club_admin", "super_admin"],
    elo: ["player", "club_admin", "super_admin"],
    statistics: ["player", "club_admin", "super_admin"],
    membership: ["player", "club_admin", "super_admin"],
  }),
  admin: Object.freeze({
    "board-setup-options": ["club_admin", "super_admin"],
    "normal-board": ["club_admin", "super_admin"],
    "pair-tablet": ["club_admin", "super_admin"],
    scolia: ["club_admin", "super_admin"],
    "member-activation": ["club_admin", "super_admin"],
    "create-tournament": ["club_admin", "super_admin"],
    "checkin-start": ["club_admin", "super_admin"],
    "run-tournament": ["club_admin", "super_admin"],
    elo: ["club_admin", "super_admin"],
    "live-finish": ["club_admin", "super_admin"],
  }),
});

let currentRole = "";
let accessResolved = false;
let resolvingAccess = null;

function closeMobileDrawer() {
  document.body.classList.remove("unified-mobile-drawer-open");
  const overlay = document.getElementById("unifiedMobileDrawerOverlay");
  if (overlay) overlay.hidden = true;
  const more = document.getElementById("unifiedMobileMore");
  if (more) {
    more.setAttribute("aria-expanded", "false");
    more.classList.remove("active");
  }
  const nav = document.querySelector(".portal-menu");
  if (nav && window.matchMedia("(max-width: 760px)").matches) {
    nav.setAttribute("aria-hidden", "true");
    if ("inert" in nav) nav.inert = true;
  }
}

function allowedTopicIds() {
  if (!accessResolved || !currentRole) return new Set();
  const access = TOPIC_ACCESS[SURFACE] || {};
  return new Set(Object.entries(access)
    .filter(([, roles]) => roles.includes(currentRole))
    .map(([id]) => id));
}

function hasGuideAccess() {
  return allowedTopicIds().size > 0;
}

function setLauncherVisibility() {
  const visible = hasGuideAccess();
  document.querySelectorAll(".bd-guide-open,#bdGuideMobileOpen").forEach((node) => {
    node.classList.toggle("hidden", !visible);
    node.toggleAttribute("hidden", !visible);
    node.setAttribute("aria-hidden", visible ? "false" : "true");
    if ("disabled" in node) node.disabled = !visible;
  });
}

function applyDialogAccess() {
  const dialog = document.querySelector("dialog.bd-user-guide");
  if (!dialog) return;
  const allowed = allowedTopicIds();
  const buttons = [...dialog.querySelectorAll(".bd-guide-toc button[data-topic]")];

  buttons.forEach((button) => {
    const permitted = allowed.has(String(button.dataset.topic || ""));
    button.classList.toggle("hidden", !permitted);
    button.toggleAttribute("hidden", !permitted);
    button.setAttribute("aria-hidden", permitted ? "false" : "true");
    button.disabled = !permitted;
  });

  const visibleButtons = buttons.filter((button) => !button.hidden && !button.disabled);
  const active = buttons.find((button) => button.classList.contains("active"));
  if (active && (active.hidden || active.disabled) && visibleButtons[0]) {
    visibleButtons[0].click();
  }

  if (!visibleButtons.length && dialog.open) {
    const article = dialog.querySelector(".bd-guide-article");
    if (article) {
      article.innerHTML = `<p class="bd-guide-group">Tilgang</p><h3>Ingen guider tilgjengelig</h3><p class="bd-guide-summary">Denne kontoen har ikke tilgang til guideemner på denne flaten.</p>`;
    }
  }
}

async function resolveAccess() {
  if (resolvingAccess) return resolvingAccess;
  resolvingAccess = (async () => {
    const token = localStorage.getItem("bd:token") || "";
    if (!token) {
      currentRole = "";
      accessResolved = true;
      return;
    }
    try {
      const user = app?.session?.resolve ? await app.session.resolve() : null;
      currentRole = String(user?.role || "");
    } catch {
      currentRole = "";
    } finally {
      accessResolved = true;
    }
  })();

  try {
    await resolvingAccess;
  } finally {
    resolvingAccess = null;
    setLauncherVisibility();
    applyDialogAccess();
  }
}

function openGuide() {
  closeMobileDrawer();
  resolveAccess().then(() => {
    if (!hasGuideAccess()) return;
    window.BlindleiaUserGuide?.open?.();
    window.setTimeout(applyDialogAccess, 0);
  });
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .bd-guide-open{
      border:1px solid rgba(47,111,237,.24)!important;
      background:#edf4ff!important;
      color:#174f91!important;
      font-weight:800!important;
      opacity:1!important;
    }
    .bd-guide-open::before{
      opacity:1!important;
      background:rgba(255,255,255,.7)!important;
    }
    .bd-guide-open:hover,.bd-guide-open:focus-visible{
      border-color:rgba(47,111,237,.38)!important;
      background:#e3eeff!important;
      color:#123f77!important;
    }
    .bd-guide-mobile-open{display:none!important}

    @media(min-width:981px){
      .portal-menu .bd-guide-open{
        margin-top:8px!important;
        border-color:rgba(255,255,255,.18)!important;
        background:rgba(255,255,255,.08)!important;
        color:#eef6ff!important;
      }
      .portal-menu .bd-guide-open::before{background:rgba(255,255,255,.08)!important}
      .portal-menu .bd-guide-open:hover,.portal-menu .bd-guide-open:focus-visible{
        border-color:rgba(255,255,255,.28)!important;
        background:rgba(255,255,255,.14)!important;
        color:#fff!important;
      }
    }

    @media(min-width:761px) and (max-width:980px){
      .portal-menu .bd-guide-open{
        min-height:44px!important;
        justify-content:center!important;
        text-align:center!important;
      }
    }

    @media(max-width:760px){
      .portal-menu .bd-guide-open{
        min-height:46px!important;
        margin-top:6px!important;
        padding:11px 13px!important;
        border-color:rgba(255,255,255,.18)!important;
        background:rgba(255,255,255,.08)!important;
        color:#eef6ff!important;
        font-size:14px!important;
      }
      .portal-menu .bd-guide-open::before{background:rgba(255,255,255,.08)!important}
      .portal-menu .bd-guide-open:hover,.portal-menu .bd-guide-open:focus-visible{
        border-color:rgba(255,255,255,.28)!important;
        background:rgba(255,255,255,.14)!important;
        color:#fff!important;
      }
      .unified-mobile-bottom-nav:has(.bd-guide-mobile-open:not([hidden])){
        grid-template-columns:repeat(5,minmax(0,1fr))!important;
      }
      .unified-mobile-bottom-nav .bd-guide-mobile-open:not([hidden]){
        display:flex!important;
      }
      .bd-guide-mobile-icon{
        width:24px;
        height:24px;
        display:grid;
        place-items:center;
        border:2px solid currentColor;
        border-radius:50%;
        font-size:14px;
        font-weight:900;
        line-height:1;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureMobileButton() {
  const bottom = document.getElementById("unifiedMobileBottomNav");
  if (!bottom) return;
  let button = document.getElementById("bdGuideMobileOpen");
  if (!button) {
    button = document.createElement("button");
    button.id = "bdGuideMobileOpen";
    button.className = "bd-guide-mobile-open hidden";
    button.type = "button";
    button.hidden = true;
    button.setAttribute("aria-label", "Åpne brukerguide");
    button.innerHTML = `<span class="bd-guide-mobile-icon" aria-hidden="true">?</span><span>Guide</span>`;
    button.addEventListener("click", openGuide);
  }
  const more = document.getElementById("unifiedMobileMore");
  if (more && button.nextElementSibling !== more) bottom.insertBefore(button, more);
  else if (!button.isConnected) bottom.appendChild(button);
}

function refresh() {
  ensureStyles();
  ensureMobileButton();
  setLauncherVisibility();
  applyDialogAccess();
}

const observer = new MutationObserver(refresh);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener("storage", (event) => {
  if (event.key !== "bd:token") return;
  accessResolved = false;
  currentRole = "";
  resolveAccess().catch(() => undefined);
});
window.addEventListener("bd:session", () => {
  accessResolved = false;
  currentRole = "";
  resolveAccess().catch(() => undefined);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    refresh();
    resolveAccess().catch(() => undefined);
  }, { once: true });
} else {
  refresh();
  resolveAccess().catch(() => undefined);
}

window.BlindleiaUserGuideAccess = Object.freeze({
  surface: SURFACE,
  role: () => currentRole,
  allowedTopicIds: () => [...allowedTopicIds()],
  canOpen: hasGuideAccess,
  refresh: applyDialogAccess,
});
