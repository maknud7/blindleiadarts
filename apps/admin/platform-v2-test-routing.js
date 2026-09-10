(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const isTestEnvironment = /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || document.documentElement.dataset.appEnv === "test"
    || document.body?.dataset.appEnv === "test";

  if (!isTestEnvironment) return;

  function prodKioskUrl() {
    const url = new URL(window.location.href);
    url.hostname = url.hostname.replace(/^test\./i, "");
    url.pathname = "/kiosk/";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const ROUTES = Object.freeze({
    equipment: "/v2/equipment/",
    kiosk: prodKioskUrl(),
  });
  const EQUIPMENT_HASHES = new Set(["#equipment", "#kiosks", "#admin/kiosks"]);

  function wireLinks() {
    document.querySelectorAll('a[href="#kiosks"],a[href="#equipment"],a[href$="#equipment"],a[href$="#kiosks"]').forEach((link) => {
      link.setAttribute("href", ROUTES.equipment);
      link.dataset.platformV2Route = "equipment";
      link.removeAttribute("target");
    });

    document.querySelectorAll('#kiosks a[href="../kiosk/"],a[data-platform-route="kiosk"]').forEach((link) => {
      link.setAttribute("href", ROUTES.kiosk);
      link.dataset.platformV2Route = "kiosk";
      link.removeAttribute("target");
      link.removeAttribute("rel");
    });
  }

  function redirectLegacyEquipmentRoute() {
    const hash = String(window.location.hash || "").trim().toLowerCase();
    if (EQUIPMENT_HASHES.has(hash)) {
      window.location.replace(ROUTES.equipment);
      return true;
    }
    return false;
  }

  function equipmentLink(link) {
    const raw = String(link.getAttribute("href") || "").trim();
    if (!raw) return false;
    try {
      const target = new URL(raw, window.location.href);
      return target.origin === window.location.origin && EQUIPMENT_HASHES.has(target.hash.toLowerCase());
    } catch {
      return false;
    }
  }

  if (redirectLegacyEquipmentRoute()) return;
  wireLinks();
  document.addEventListener("DOMContentLoaded", wireLinks, { once: true });
  window.addEventListener("bd:portal-view", wireLinks);
  window.addEventListener("hashchange", redirectLegacyEquipmentRoute);
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target || !equipmentLink(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(ROUTES.equipment);
  }, true);
})();
