function ensureStylesheet(url) {
  const href = new URL(url, import.meta.url).href;
  if ([...document.styleSheets].some((sheet) => sheet.href === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

ensureStylesheet("./portal-brand.css");
ensureStylesheet("./password-reset.css");
ensureStylesheet("./mobile-portal.css");

import(new URL("./password-reset.js", import.meta.url).href).catch((error) => console.warn("Password reset UI unavailable", error));

const NAV_SELECTOR = "[data-portal-nav], .section-nav a[href^='#'], .portal-nav a[href^='#']";
const SECTION_SELECTOR = "[data-portal-section], main > section[id], .shell > section[id]";

function normalizeTarget(value) {
  return String(value || "").replace(/^#/, "").trim();
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
  if (updateHash && window.location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);

  // This event means that the user actually changed portal view. DOM rendering
  // inside the active view must never re-emit it; doing so creates fetch/render
  // feedback loops in modules that load data when a view is entered.
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
  const token = localStorage.getItem("bd:token") || "";
  if (!token) {
    gated.forEach((node) => node.classList.add("hidden"));
    lastRoleToken = null;
    return;
  }
  if (lastRoleToken === token && gated.every((node) => node.dataset.roleResolved === "1")) return;
  try {
    const response = await fetch("../api/v1/auth/me", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    const role = payload?.data?.user?.role || "";
    const allowed = ["club_admin", "super_admin"].includes(role);
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
  bindLinks();
  const requested = normalizeTarget(window.location.hash);
  const current = normalizeTarget(document.body.dataset.portalActive);
  activate(targets().has(requested) ? requested : current || defaultTarget(), { updateHash: false });
  syncRoleAccess().catch(() => undefined);
}

const style = document.createElement("style");
style.textContent = `
.portal-view-hidden{display:none!important}
.section-nav a.active,.portal-nav a.active{border-color:var(--accent,#11435d)!important;background:var(--accent,#11435d)!important;color:#fff!important}
.portal-menu{position:sticky;top:84px;z-index:12;padding:10px;border-radius:16px;backdrop-filter:blur(16px)}
.portal-nav.portal-menu{grid-template-columns:repeat(auto-fit,minmax(105px,1fr))}
.portal-shortcuts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}
.shortcut-card{display:grid;gap:6px;min-height:104px;padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--panel-2,rgba(255,255,255,.78));color:inherit;text-decoration:none}
.shortcut-card strong{font-size:17px}.shortcut-card span{color:var(--muted);font-size:13px;line-height:1.45}
[data-portal-section]{animation:portalViewIn .14s ease-out}@keyframes portalViewIn{from{opacity:.45;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(max-width:760px){.portal-menu{top:0}.portal-shortcuts{grid-template-columns:1fr}}
`;
document.head.appendChild(style);

window.addEventListener("hashchange", () => activate(window.location.hash, { updateHash: false }));
window.addEventListener("storage", () => syncRoleAccess().catch(() => undefined));
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
