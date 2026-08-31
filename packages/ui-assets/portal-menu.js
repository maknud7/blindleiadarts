import(new URL("./user-guide.js?v=20260831-1405", import.meta.url).href)
  .then(() => import(new URL("./user-guide-access.js?v=20260831-1405", import.meta.url).href))
  .catch((error) => console.warn("User guide unavailable", error));

const app = window.BlindleiaApp || (await import(new URL("./app-core.js?v=20260827-1900", import.meta.url).href)).default;

function ensureStylesheet(url) {
  const href = new URL(url, import.meta.url).href;
  if ([...document.styleSheets].some((sheet) => sheet.href === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function ensureFavicon() {
  const iconHref = new URL("../../static/club-logos/blindleia-dartklubb-logo.svg?v=20260831-1305", import.meta.url).href;
  const touchHref = new URL("../../static/club-logos/blindleia-dartklubb-logo.png?v=20260831-1305", import.meta.url).href;

  let icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.type = "image/svg+xml";
  icon.href = iconHref;

  let touch = document.querySelector('link[rel="apple-touch-icon"]');
  if (!touch) {
    touch = document.createElement("link");
    touch.rel = "apple-touch-icon";
    document.head.appendChild(touch);
  }
  touch.href = touchHref;
}

ensureFavicon();
ensureStylesheet("./portal-brand.css?v=20260826-1205");
ensureStylesheet("./password-reset.css");
ensureStylesheet("./mobile-portal.css?v=20260826-1205");
ensureStylesheet("./unified-portal-shell.css?v=20260827-1900");
ensureStylesheet("./mobile-app-nav.css?v=20260827-1430");

if (document.body.dataset.bdSurface === "admin") {
  ensureStylesheet("./admin-shell-v2.css?v=20260827-1238");
  import(new URL("./admin-shell-v2.js?v=20260827-1238", import.meta.url).href)
    .catch((error) => console.warn("Admin shell unavailable", error));
}

import(new URL("./unified-portal-shell.js?v=20260827-1900", import.meta.url).href)
  .catch((error) => console.warn("Unified portal shell unavailable", error));
import(new URL("./password-reset.js", import.meta.url).href).catch((error) => console.warn("Password reset UI unavailable", error));

const NAV_SELECTOR = "[data-portal-nav], .section-nav a[href^='#'], .portal-nav a[href^='#']";
const SECTION_SELECTOR = "[data-portal-section], main > section[id], .shell > section[id]";
const CANONICAL_ROOT = document.body.dataset.canonicalRoot === "1";
const ADMIN_SURFACE = document.body.dataset.bdSurface === "admin" || document.body.dataset.portalDefault === "overview";
const ADMIN_CANONICAL_TO_LOCAL = Object.freeze({
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
  if (CANONICAL_ROOT && ADMIN_SURFACE) {
    if (target === "admin") return "overview";
    if (target.startsWith("admin/")) target = target.slice(6);
    target = ADMIN_CANONICAL_TO_LOCAL[target] || target;
  }
  return target;
}

function canonicalHash(target) {
  const next = normalizeTarget(target);
  if (CANONICAL_ROOT && ADMIN_SURFACE) return app.router.href("admin", next);
  return app.router.href("player", next);
}

function hashRequestsAdmin() {
  return app.router.route(window.location.hash).surface === "admin";
}

function canonicalSurfaceMismatch() {
  if (!CANONICAL_ROOT) return false;
  return hashRequestsAdmin() !== ADMIN_SURFACE;
}

function links() {
  return [...document.querySelectorAll(NAV_SELECTOR)].filter((node) => !node.classList.contains("hidden"));
}

function sections() {
  const nodes = [...document.querySelectorAll(SECTION_SELECTOR)];
  nodes.forEach((node) => {
    if (!node.dataset.portalSection && node.id) node.dataset.portalSection = node.id;
  });
  return nodes.filter((node) => node.dataset.portalSection);
}

function targets() {
  return new Set(sections().map((node) => normalizeTarget(node.dataset.portalSection)));
}

function defaultTarget() {
  const preferred = document.body.dataset.portalDefault;
  if (preferred && targets().has(preferred)) return preferred;
  const firstLink = links().find((node) => targets().has(normalizeTarget(node.getAttribute("href"))));
  if (firstLink) return normalizeTarget(firstLink.getAttribute("href"));
  return normalizeTarget(sections()[0]?.dataset.portalSection || "");
}

function activate(target, { updateHash = true } = {}) {
  const available = targets();
  let next = normalizeTarget(target);
  if (!available.has(next)) next = defaultTarget();
  if (!next) return;

  const previous = normalizeTarget(document.body.dataset.portalActive);
  const changed = previous !== next;

  sections().forEach((node) => {
    const active = normalizeTarget(node.dataset.portalSection) === next;
    node.classList.toggle("portal-view-hidden", !active);
    node.toggleAttribute("aria-hidden", !active);
  });

  links().forEach((node) => {
    const active = normalizeTarget(node.getAttribute("href")) === next;
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });

  document.body.dataset.portalActive = next;
  const nextHash = canonicalHash(next);
  if (updateHash && window.location.hash !== nextHash) history.replaceState(null, "", nextHash);

  if (changed) {
    window.dispatchEvent(new CustomEvent("bd:portal-view", { detail: { target: next, previous } }));
  }
}

function bindLinks() {
  links().forEach((node) => {
    if (node.dataset.portalBound === "1") return;
    node.dataset.portalNav = node.dataset.portalNav || "1";
    node.dataset.portalBound = "1";
    node.addEventListener("click", (event) => {
      const target = normalizeTarget(node.getAttribute("href"));
      if (!target || !targets().has(target)) return;
      event.preventDefault();
      activate(target);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

let lastRoleToken = null;
async function syncRoleAccess() {
  const gated = [...document.querySelectorAll("#adminPortalLink,[data-role-access='admin']")];
  if (!gated.length) return;
  const token = app.session.token();
  if (!token) {
    gated.forEach((node) => node.classList.add("hidden"));
    lastRoleToken = null;
    return;
  }
  if (lastRoleToken === token && gated.every((node) => node.dataset.roleResolved === "1")) return;
  try {
    const user = await app.session.resolve();
    const allowed = app.session.isAdmin(user);
    gated.forEach((node) => {
      node.classList.toggle("hidden", !allowed);
      node.dataset.roleResolved = "1";
    });
    lastRoleToken = token;
  } catch {
    gated.forEach((node) => node.classList.add("hidden"));
  }
}

function refresh() {
  if (canonicalSurfaceMismatch()) {
    window.location.reload();
    return;
  }
  bindLinks();
  const requested = normalizeTarget(window.location.hash);
  const current = normalizeTarget(document.body.dataset.portalActive);
  activate(targets().has(requested) ? requested : current || defaultTarget(), { updateHash: false });
  syncRoleAccess().catch(() => undefined);
}

const style = document.createElement("style");
style.textContent = `
.portal-view-hidden{display:none!important}
.section-nav a.active,.portal-nav a.active{border-color:var(--accent,#2f6fed)!important;background:var(--accent,#2f6fed)!important;color:#fff!important}
.portal-menu{position:sticky;top:84px;z-index:12;padding:10px;border-radius:14px;backdrop-filter:blur(16px)}
.portal-nav.portal-menu{grid-template-columns:repeat(auto-fit,minmax(105px,1fr))}
.portal-shortcuts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}
.shortcut-card{display:grid;gap:6px;min-height:104px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2,rgba(255,255,255,.78));color:inherit;text-decoration:none}
.shortcut-card strong{font-size:17px}.shortcut-card span{color:var(--muted);font-size:13px;line-height:1.45}
[data-portal-section]{animation:portalViewIn .14s ease-out}@keyframes portalViewIn{from{opacity:.45;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(max-width:760px){.portal-menu{top:0}.portal-shortcuts{grid-template-columns:1fr}}
`;
document.head.appendChild(style);

window.addEventListener("hashchange", () => {
  if (canonicalSurfaceMismatch()) {
    window.location.reload();
    return;
  }
  activate(window.location.hash, { updateHash: false });
});
window.addEventListener("storage", () => syncRoleAccess().catch(() => undefined));
window.addEventListener("bd:session", () => syncRoleAccess().catch(() => undefined));
window.setInterval(() => syncRoleAccess().catch(() => undefined), 5000);

let refreshQueued = false;
const observer = new MutationObserver(() => {
  if (refreshQueued) return;
  refreshQueued = true;
  window.requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
});
observer.observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
else refresh();
