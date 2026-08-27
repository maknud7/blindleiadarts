const app = window.BlindleiaApp;
const surface = document.body.dataset.bdSurface === "admin" || document.body.dataset.portalDefault === "overview" ? "admin" : "player";
const nav = document.querySelector(".portal-menu");
const token = () => localStorage.getItem("bd:token") || "";
const canonicalRoot = document.body.dataset.canonicalRoot === "1";
const rootPathMatch = window.location.pathname.match(/^(.*\/)(?:player|admin)\/(?:index\.html)?$/i);
const rootPath = canonicalRoot
  ? (window.location.pathname.endsWith("/") ? window.location.pathname : window.location.pathname.replace(/[^/]*$/, ""))
  : (rootPathMatch?.[1] || "/");
let currentRole = "";
let currentUserLabel = "";
let syncing = false;
let clubObserver = null;
let mobileNavBound = false;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleLabel(role) {
  if (role === "super_admin") return "Superadmin";
  if (role === "club_admin") return "Klubbadministrator";
  return role ? "Spiller" : "Ikke innlogget";
}

function initials(value) {
  const parts = String(value || "BD").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "BD";
}

function rootRoute(targetSurface, view) {
  const base = rootPath || "/";
  const hash = app?.router?.href ? app.router.href(targetSurface, view) : (targetSurface === "admin" ? "#club" : `#${view || "home"}`);
  return `${base}${hash}`;
}

function ensureRuntimeStyles() {
  if (document.getElementById("unifiedRuntimeStyles")) return;
  const style = document.createElement("style");
  style.id = "unifiedRuntimeStyles";
  style.textContent = `
    .unified-group-label.admin.club-admin{color:#b8cbe0!important}
    .unified-group-label.admin.club-admin::before{content:"◆"!important;font-size:8px!important;color:#7fb2e8!important}
    .unified-group-label.admin.super-admin{color:var(--unified-gold,#f0bd42)!important}
    .unified-group-label.admin.super-admin::before{content:"♛"!important}
    .unified-clubadmin-link::after{background:#7fb2e8!important;opacity:.55!important}
    .unified-superadmin-link::after{background:var(--unified-gold,#f0bd42)!important;opacity:1!important}
    #unifiedPlayerTopbar .portal-context.unified-single-club label[for="clubSelect"],
    #unifiedPlayerTopbar .portal-context.unified-single-club #clubSelect{display:none!important}
    #superadmin{display:grid;gap:16px}
    #superadmin .superadmin-stack{display:grid;gap:16px}
  `;
  document.head.appendChild(style);
}

function ensurePlayerTopbar() {
  if (surface !== "player" || document.getElementById("unifiedPlayerTopbar")) return;
  const shell = document.querySelector(".shell");
  if (!shell) return;

  const topbar = document.createElement("header");
  topbar.id = "unifiedPlayerTopbar";
  topbar.className = "unified-player-topbar";
  topbar.innerHTML = `
    <div class="unified-topbar-brand">
      <span class="unified-topbar-logo" aria-hidden="true"></span>
      <div><small>Blindleia Darts</small><strong>Blindleia Dartklubb</strong></div>
    </div>
    <div class="unified-topbar-actions"></div>`;
  shell.before(topbar);

  const context = shell.querySelector(".portal-context");
  if (context) topbar.querySelector(".unified-topbar-actions")?.appendChild(context);
}

function syncSingleClubChooser() {
  if (surface !== "player") return;
  const select = document.getElementById("clubSelect");
  const context = select?.closest(".portal-context");
  if (!select || !context) return;
  const actualClubs = [...select.options].filter((option) => String(option.value || "").trim() !== "");
  context.classList.toggle("unified-single-club", actualClubs.length === 1);
}

function watchClubChooser() {
  if (surface !== "player") return;
  const select = document.getElementById("clubSelect");
  if (!select) return;
  clubObserver?.disconnect();
  clubObserver = new MutationObserver(syncSingleClubChooser);
  clubObserver.observe(select, { childList: true, subtree: true });
  select.addEventListener("change", syncSingleClubChooser);
  syncSingleClubChooser();
}

function makeLink(href, label, className = "", targetSurface = surface) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  link.dataset.surfaceTarget = targetSurface;
  if (className) link.className = className;
  if (canonicalRoot && targetSurface !== surface) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      history.replaceState(null, "", href);
      window.location.reload();
    });
  }
  return link;
}

function removeGenerated() {
  nav?.querySelectorAll(".unified-generated").forEach((node) => node.remove());
}

function getAdminLocalLinks() {
  if (!nav || surface !== "admin") return [];
  return [...nav.querySelectorAll(':scope > a[href^="#"]')].filter((link) => link.id !== "adminPortalLink");
}

function getPlayerLocalLinks() {
  if (!nav || surface !== "player") return [];
  return [...nav.querySelectorAll(':scope > a[href^="#"]')].filter((link) => link.id !== "adminPortalLink");
}

function normalizeLocalLabels() {
  if (!nav) return;
  if (surface === "admin") {
    const labels = {
      "#overview": "Klubboversikt",
      "#tournaments": "Turneringsadmin",
      "#seasons": "Sesonger",
      "#playerbase": "Spillere",
      "#players": "Medlemmer",
      "#kiosks": "Utstyr",
      "#integrations": "Innstillinger",
    };
    Object.entries(labels).forEach(([href, label]) => {
      const link = nav.querySelector(`:scope > a[href="${href}"]`);
      if (link) link.textContent = label;
    });
  } else {
    const labels = {
      "#home": "Hjem",
      "#tournaments": "Turneringer",
      "#statistics": "Statistikk",
      "#profile": "Min profil",
    };
    Object.entries(labels).forEach(([href, label]) => {
      const link = nav.querySelector(`:scope > a[href="${href}"]`);
      if (link) link.textContent = label;
    });
  }
}

function ensureBrand() {
  if (!nav) return;
  const brand = document.createElement("div");
  brand.className = "unified-sidebar-brand unified-generated";
  brand.innerHTML = `<div><strong>Blindleia<br>Dartklubb</strong><small>Blindleia Darts</small></div>`;
  nav.prepend(brand);
}

function addGroupLabel(text, admin = false, before = null, level = "") {
  if (!nav) return null;
  const label = document.createElement("span");
  label.className = `unified-group-label unified-generated${admin ? " admin" : ""}${level ? ` ${level}` : ""}`;
  label.textContent = text;
  if (before) nav.insertBefore(label, before);
  else nav.appendChild(label);
  return label;
}

function buildCommonGroup() {
  if (!nav) return;
  if (surface === "player") {
    const links = getPlayerLocalLinks();
    if (links.length) addGroupLabel("Portal", false, links[0]);
    return;
  }

  const firstLocal = getAdminLocalLinks()[0] || null;
  const label = addGroupLabel("Portal", false, firstLocal);
  const common = [
    ["home", "Hjem"],
    ["tournaments", "Turneringer"],
    ["statistics", "Statistikk"],
    ["profile", "Min profil"],
  ];
  common.forEach(([view, text]) => {
    const link = makeLink(rootRoute("player", view), text, "unified-generated", "player");
    nav.insertBefore(link, firstLocal);
  });
  const firstCommon = nav.querySelector('[data-surface-target="player"].unified-generated');
  if (label && firstCommon) nav.insertBefore(label, firstCommon);
}

function adminAllowed() {
  return ["club_admin", "super_admin"].includes(currentRole);
}

function ensureSuperAdminSection() {
  if (surface !== "admin") return null;
  const main = document.querySelector("main.main");
  const overview = document.getElementById("overview");
  const health = document.querySelector(".health-tracker");
  let section = document.getElementById("superadmin");

  if (currentRole !== "super_admin") {
    if (section) {
      if (health && overview && health.parentElement === section) overview.appendChild(health);
      section.remove();
    }
    health?.classList.add("hidden");
    return null;
  }

  if (!main) return null;
  if (!section) {
    section = document.createElement("section");
    section.id = "superadmin";
    section.dataset.portalSection = "superadmin";
    section.className = "portal-view";
    section.innerHTML = `
      <div class="hero">
        <div>
          <p class="eyebrow">Plattform</p>
          <h1>Superadmin</h1>
          <p class="muted">Plattformhelse, identitetsopprydding, revisjon og logger som gjelder hele Blindleia Darts.</p>
        </div>
      </div>
      <div id="superadminIdentityAuditHost" class="superadmin-stack"></div>
      <div id="superadminActivityHost" class="superadmin-stack"></div>`;
    main.appendChild(section);
  }
  if (health && health.parentElement !== section) section.insertBefore(health, document.getElementById("superadminIdentityAuditHost"));
  health?.classList.remove("hidden");
  window.dispatchEvent(new CustomEvent("bd:superadmin-ready"));
  return section;
}

function markClubAdminLinks(links) {
  links.forEach((link) => {
    link.classList.add("unified-admin-link", "unified-clubadmin-link");
    link.classList.remove("unified-superadmin-link");
  });
}

function buildAdminGroup() {
  if (!nav || !adminAllowed()) return;

  const clubItems = [
    ["overview", "Klubboversikt"],
    ["tournaments", "Turneringsadmin"],
    ["seasons", "Sesonger"],
    ["playerbase", "Spillere"],
    ["players", "Medlemmer"],
    ["kiosks", "Utstyr"],
    ["integrations", "Innstillinger"],
  ];

  if (surface === "admin") {
    const localLinks = getAdminLocalLinks().filter((link) => link.getAttribute("href") !== "#superadmin");
    if (localLinks.length) {
      addGroupLabel("Klubbadmin", true, localLinks[0], "club-admin");
      markClubAdminLinks(localLinks);
    }
    if (currentRole === "super_admin") {
      ensureSuperAdminSection();
      addGroupLabel("Superadmin", true, null, "super-admin");
      nav.appendChild(makeLink("#superadmin", "Superadmin", "unified-generated unified-admin-link unified-superadmin-link", "admin"));
    }
    return;
  }

  const clubLabel = addGroupLabel("Klubbadmin", true, null, "club-admin");
  clubItems.forEach(([view, text]) => {
    nav.appendChild(makeLink(rootRoute("admin", view), text, "unified-generated unified-admin-link unified-clubadmin-link", "admin"));
  });
  if (clubLabel) clubLabel.dataset.roleAccess = "admin";

  if (currentRole === "super_admin") {
    addGroupLabel("Superadmin", true, null, "super-admin");
    nav.appendChild(makeLink(rootRoute("admin", "superadmin"), "Superadmin", "unified-generated unified-admin-link unified-superadmin-link", "admin"));
  }
}

function buildAccount() {
  if (!nav) return;
  const label = currentUserLabel || (token() ? "Innlogget" : "Gjest");
  const account = document.createElement("div");
  account.className = "unified-sidebar-account unified-generated";
  account.innerHTML = `<span class="unified-sidebar-avatar">${esc(initials(label))}</span><div><strong>${esc(label)}</strong><small>${esc(roleLabel(currentRole))}</small></div>`;
  nav.appendChild(account);
}

function mobileIcon(name) {
  const icons = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>',
    tournament: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3a4 4 0 0 1-8 0V4Zm-3 1h3v2H7a2 2 0 0 0 2 2v2C6.8 11 5 9.2 5 7V5Zm11 0h3v2c0 2.2-1.8 4-4 4V9a2 2 0 0 0 2-2h-1V5ZM11 11h2v4h3v2H8v-2h3v-4Zm-4 7h10v2H7v-2Z"/></svg>',
    stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9h3v10H5Zm5 0V5h3v14h-3Zm5 0v-7h3v7h-3Z"/></svg>',
    members: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6.5-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-4 3.1-7 7-7s7 3 7 7H2Zm13.2-7c3.8 0 6.8 2.6 6.8 6h-4.1a9.2 9.2 0 0 0-2.7-6Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.7 5.3 5.3 5.3 5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h9v2H6v14h7v2H4V3Zm11.6 4.6L20 12l-4.4 4.4-1.4-1.4 2-2H9v-2h7.2l-2-2 1.4-1.4Z"/></svg>',
  };
  return icons[name] || icons.more;
}

function mobileQuickItems() {
  if (surface === "admin") {
    return [
      ["overview", "Oversikt", "home", "admin"],
      ["tournaments", "Turneringer", "tournament", "admin"],
      ["players", "Medlemmer", "members", "admin"],
    ];
  }
  return [
    ["home", "Hjem", "home", "player"],
    ["tournaments", "Turneringer", "tournament", "player"],
    ["statistics", "Statistikk", "stats", "player"],
  ];
}

function normalizedCurrentView() {
  const route = app?.router?.route ? app.router.route(window.location.hash) : null;
  if (route && route.surface === surface) return route.view;
  let hash = String(window.location.hash || "").replace(/^#/, "").trim();
  if (hash.startsWith("admin/")) hash = hash.slice(6);
  if (!hash || hash === "admin") return surface === "admin" ? "overview" : "home";
  return hash;
}

function setMobileDrawer(open) {
  if (!window.matchMedia("(max-width: 760px)").matches) open = false;
  document.body.classList.toggle("unified-mobile-drawer-open", open);
  const overlay = document.getElementById("unifiedMobileDrawerOverlay");
  const more = document.getElementById("unifiedMobileMore");
  if (overlay) overlay.hidden = !open;
  if (more) more.setAttribute("aria-expanded", open ? "true" : "false");
  if (nav) {
    nav.setAttribute("aria-hidden", open ? "false" : "true");
    if ("inert" in nav) nav.inert = !open;
  }
  syncMobileBottomNav();
}

function syncMobileNavigationMode() {
  if (!nav) return;
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  if (!mobile) {
    document.body.classList.remove("unified-mobile-drawer-open");
    nav.removeAttribute("aria-hidden");
    if ("inert" in nav) nav.inert = false;
    const overlay = document.getElementById("unifiedMobileDrawerOverlay");
    if (overlay) overlay.hidden = true;
    return;
  }
  const open = document.body.classList.contains("unified-mobile-drawer-open");
  nav.setAttribute("aria-hidden", open ? "false" : "true");
  if ("inert" in nav) nav.inert = !open;
}

function syncMobileBottomNav() {
  const bottom = document.getElementById("unifiedMobileBottomNav");
  if (!bottom) return;
  const current = normalizedCurrentView();
  const drawerOpen = document.body.classList.contains("unified-mobile-drawer-open");
  let matched = false;
  bottom.querySelectorAll("[data-mobile-view]").forEach((item) => {
    const active = item.dataset.mobileView === current;
    item.classList.toggle("active", active);
    if (active) matched = true;
  });
  const more = document.getElementById("unifiedMobileMore");
  more?.classList.toggle("active", drawerOpen || !matched);
}

function ensureMobileNavigation() {
  if (!nav || document.getElementById("unifiedMobileBottomNav")) return;

  const close = document.createElement("button");
  close.id = "unifiedMobileDrawerClose";
  close.className = "unified-mobile-drawer-close";
  close.type = "button";
  close.setAttribute("aria-label", "Lukk meny");
  close.innerHTML = mobileIcon("close");
  close.addEventListener("click", () => setMobileDrawer(false));
  nav.prepend(close);

  const logout = document.createElement("button");
  logout.id = "unifiedMobileDrawerLogout";
  logout.className = "unified-mobile-drawer-logout";
  logout.type = "button";
  logout.innerHTML = `${mobileIcon("logout")}<span>Logg ut</span>`;
  logout.addEventListener("click", () => {
    const existing = document.getElementById("logoutButton");
    if (existing) existing.click();
    else {
      localStorage.removeItem("bd:token");
      window.location.reload();
    }
  });
  nav.appendChild(logout);

  const overlay = document.createElement("div");
  overlay.id = "unifiedMobileDrawerOverlay";
  overlay.className = "unified-mobile-drawer-overlay";
  overlay.hidden = true;
  overlay.addEventListener("click", () => setMobileDrawer(false));
  document.body.appendChild(overlay);

  const bottom = document.createElement("nav");
  bottom.id = "unifiedMobileBottomNav";
  bottom.className = "unified-mobile-bottom-nav";
  bottom.setAttribute("aria-label", surface === "admin" ? "Klubbadmin" : "Hovedmeny");

  mobileQuickItems().forEach(([view, label, icon, targetSurface]) => {
    const link = document.createElement("a");
    link.href = rootRoute(targetSurface, view);
    link.dataset.mobileView = view;
    link.innerHTML = `${mobileIcon(icon)}<span>${label}</span>`;
    link.addEventListener("click", () => setMobileDrawer(false));
    bottom.appendChild(link);
  });

  const more = document.createElement("button");
  more.id = "unifiedMobileMore";
  more.type = "button";
  more.setAttribute("aria-controls", nav.id || "");
  more.setAttribute("aria-expanded", "false");
  more.innerHTML = `${mobileIcon("more")}<span>Mer</span>`;
  more.addEventListener("click", () => setMobileDrawer(!document.body.classList.contains("unified-mobile-drawer-open")));
  bottom.appendChild(more);
  document.body.appendChild(bottom);

  if (!mobileNavBound) {
    nav.addEventListener("click", (event) => {
      if (event.target.closest("a") && window.matchMedia("(max-width: 760px)").matches) {
        window.setTimeout(() => setMobileDrawer(false), 0);
      }
    });
    window.addEventListener("hashchange", syncMobileBottomNav);
    window.addEventListener("resize", syncMobileNavigationMode);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMobileDrawer(false);
    });
    mobileNavBound = true;
  }

  syncMobileNavigationMode();
  syncMobileBottomNav();
}

function syncMenu() {
  if (!nav || syncing) return;
  syncing = true;
  try {
    removeGenerated();
    nav.querySelectorAll(".unified-admin-link,.unified-clubadmin-link,.unified-superadmin-link").forEach((link) => {
      link.classList.remove("unified-admin-link", "unified-clubadmin-link", "unified-superadmin-link");
    });
    document.getElementById("adminToolSection")?.remove();
    ensureSuperAdminSection();
    normalizeLocalLabels();
    ensureBrand();
    buildCommonGroup();
    buildAdminGroup();
    buildAccount();
    syncSingleClubChooser();
    syncMobileBottomNav();
  } finally {
    syncing = false;
  }
}

async function resolveRole() {
  const value = token();
  if (!value) {
    currentRole = "";
    currentUserLabel = "";
    syncMenu();
    return;
  }
  try {
    const user = app?.session?.resolve ? await app.session.resolve() : null;
    currentRole = String(user?.role || "");
    currentUserLabel = String(user?.player?.display_name || user?.display_name || user?.name || user?.username || user?.email || "Innlogget");
  } catch {
    currentRole = "";
    currentUserLabel = "Innlogget";
  }
  syncMenu();
}

function initialize() {
  ensureRuntimeStyles();
  ensurePlayerTopbar();
  watchClubChooser();
  ensureMobileNavigation();
  syncMenu();
  resolveRole().catch(() => undefined);
  if (surface === "admin") {
    window.setTimeout(syncMenu, 250);
    window.setTimeout(syncMenu, 900);
    window.setTimeout(syncMenu, 1800);
  } else {
    window.setTimeout(syncSingleClubChooser, 250);
    window.setTimeout(syncSingleClubChooser, 900);
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === "bd:token") resolveRole().catch(() => undefined);
});
window.addEventListener("bd:session", () => resolveRole().catch(() => undefined));
window.addEventListener("bd:portal-view", () => {
  if (surface === "admin") window.setTimeout(syncMenu, 0);
  syncMobileBottomNav();
});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
