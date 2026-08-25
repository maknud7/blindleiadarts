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
  if (updateHash && window.location.hash !== `#${next}`) {
    history.replaceState(null, "", `#${next}`);
  }
  window.dispatchEvent(new CustomEvent("bd:portal-view", { detail: { target: next } }));
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

function refresh() {
  bindLinks();
  const requested = normalizeTarget(window.location.hash);
  const current = normalizeTarget(document.body.dataset.portalActive);
  activate(targets().has(requested) ? requested : current || defaultTarget(), { updateHash: false });
}

const style = document.createElement("style");
style.textContent = `.portal-view-hidden{display:none!important}.section-nav a.active,.portal-nav a.active{border-color:var(--accent,#11435d)!important;background:var(--accent,#11435d)!important;color:#fff!important}`;
document.head.appendChild(style);

window.addEventListener("hashchange", () => activate(window.location.hash, { updateHash: false }));

const observer = new MutationObserver(() => refresh());
observer.observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
else refresh();
