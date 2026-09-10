(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const isTestEnvironment = /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || document.documentElement.dataset.appEnv === "test"
    || document.body?.dataset.appEnv === "test";

  if (!isTestEnvironment) return;

  const ROUTES = Object.freeze({
    equipment: "/v2/equipment/",
    kiosk: "/v2/kiosk/",
  });

  function wireLinks() {
    document.querySelectorAll('a[href="#kiosks"],a[href="#equipment"]').forEach((link) => {
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
    const hash = String(window.location.hash || "").replace(/^#/, "").trim().toLowerCase();
    if (["equipment", "kiosks", "admin/kiosks"].includes(hash)) {
      window.location.replace(ROUTES.equipment);
      return true;
    }
    return false;
  }

  if (redirectLegacyEquipmentRoute()) return;
  wireLinks();
  document.addEventListener("DOMContentLoaded", wireLinks, { once: true });
  window.addEventListener("bd:portal-view", wireLinks);
})();
