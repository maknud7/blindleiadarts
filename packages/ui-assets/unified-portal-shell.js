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
      "#overview": "Adminoversikt",
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

function addGroupLabel(text, admin = false, before = null) {
  if (!nav) return null;
  const label = document.createElement("span");
  label.className = `unified-group-label unified-generated${admin ? " admin" : ""}`;
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

function buildAdminGroup() {
  if (!nav || !adminAllowed()) return;

  if (surface === "admin") {
    const localLinks = getAdminLocalLinks();
    if (!localLinks.length) return;
    addGroupLabel(currentRole === "super_admin" ? "Superadmin / klubbdrift" : "Klubbadmin", true, localLinks[0]);
    localLinks.forEach((link) => link.classList.add("unified-admin-link"));
    return;
  }

  const adminLabel = addGroupLabel(currentRole === "super_admin" ? "Superadmin / klubbdrift" : "Klubbadmin", true);
  const items = [
    ["overview", "Adminoversikt"],
    ["tournaments", "Turneringsadmin"],
    ["seasons", "Sesonger"],
    ["playerbase", "Spillere"],
    ["players", "Medlemmer"],
    ["kiosks", "Utstyr"],
    ["integrations", "Innstillinger"],
  ];
  items.forEach(([view, text]) => {
    const link = makeLink(rootRoute("admin", view), text, "unified-generated unified-admin-link", "admin");
    nav.appendChild(link);
  });
  if (adminLabel) adminLabel.dataset.roleAccess = "admin";
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
    nav.querySelectorAll(".unified-admin-link").forEach((link) => link.classList.remove("unified-admin-link"));
    document.getElementById("adminToolSection")?.remove();
    normalizeLocalLabels();
    ensureBrand();
    buildCommonGroup();
    buildAdminGroup();
    buildAccount();
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
  ensurePlayerTopbar();
  syncMenu();
  resolveRole().catch(() => undefined);
  if (surface === "admin") {
    window.setTimeout(syncMenu, 250);
    window.setTimeout(syncMenu, 900);
    window.setTimeout(syncMenu, 1800);
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
