const TEST_HOST = /^test\./i.test(window.location.hostname) || /(^|\.)test\./i.test(window.location.hostname);

if (TEST_HOST) {
  const EQUIPMENT_URL = "/v2/equipment/";
  const KIOSK_URL = "/v2/kiosk/?testmode=1";

  function routeEquipmentLink(link) {
    link.href = EQUIPMENT_URL;
    link.removeAttribute("data-portal-nav");
    link.dataset.platformV2Route = "equipment";
  }

  function routeKioskLink(link) {
    link.href = KIOSK_URL;
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.dataset.platformV2Route = "kiosk";
  }

  function applyRoutes() {
    document.querySelectorAll('a[href="#kiosks"], a[href="#equipment"], a[href$="#admin/equipment"]').forEach(routeEquipmentLink);
    document.querySelectorAll('a[href="../kiosk/"], a[href="/kiosk/"], a[href$="/kiosk/"]').forEach(routeKioskLink);
  }

  function redirectLegacyEquipmentHash() {
    const hash = String(window.location.hash || "").toLowerCase();
    if (["#kiosks", "#equipment", "#admin/equipment"].includes(hash)) {
      window.location.replace(EQUIPMENT_URL);
    }
  }

  applyRoutes();
  redirectLegacyEquipmentHash();
  document.addEventListener("DOMContentLoaded", applyRoutes, { once: true });
  window.addEventListener("hashchange", redirectLegacyEquipmentHash);

  window.BlindleiaPlatformV2Routes = Object.freeze({
    environment: "test",
    equipment: EQUIPMENT_URL,
    kiosk: KIOSK_URL,
  });
}
