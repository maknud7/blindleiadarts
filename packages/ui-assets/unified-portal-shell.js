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
  if (targetSurface === "admin") return `${base}#admin/${view || "overview"}`;
  return view ? `${base}#${view}` : base;
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
          <p class="muted">Systemstatus og funksjoner som gjelder hele Blindleia Darts-plattformen, uavhengig av klubb.</p>
        </div>
      </div>`;
    main.appendChild(section);
  }
  if (health && health.parentElement !== section) section.appendChild(health);
  health?.classList.remove("hidden");
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
      nav.appendChild(makeLink("#superadmin", "Systemstatus", "unified-generated unified-admin-link unified-superadmin-link", "admin"));
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
    nav.appendChild(makeLink(rootRoute("admin", "superadmin"), "Systemstatus", "unified-generated unified-admin-link unified-superadmin-link", "admin"));
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
    const response = await fetch("../api/v1/auth/me", {
      headers: { Authorization: `Bearer ${value}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    const user = payload?.data?.user || {};
    currentRole = String(user.role || "");
    currentUserLabel = String(user.player?.display_name || user.display_name || user.name || user.username || user.email || "Innlogget");
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
window.addEventListener("bd:portal-view", () => {
  if (surface === "admin") window.setTimeout(syncMenu, 0);
});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
