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
  // TEST still has the canonical Clubadmin equipment view. V2 is an explicit
  // opt-in link, never a hidden hijack of #equipment or #kiosks.
  function wireLinks() {
    document.querySelectorAll('#kiosks a[href="../kiosk/"],a[data-platform-route="kiosk"]').forEach((link) => {
      link.setAttribute("href", ROUTES.kiosk);
      link.dataset.platformV2Route = "kiosk";
      link.removeAttribute("target");
      link.removeAttribute("rel");
    });

    const section = document.getElementById("kiosks");
    const header = section?.querySelector(":scope > .panel-head");
    if (header && !header.querySelector("[data-v2-equipment-entry]")) {
      const link = document.createElement("a");
      link.className = "button secondary";
      link.dataset.v2EquipmentEntry = "1";
      link.href = ROUTES.equipment;
      link.textContent = "Åpne Utstyr v2 (TEST)";
      link.title = "Åpnes bare når du velger denne lenken. Den vanlige Utstyr-siden beholdes.";
      header.appendChild(link);
    }
  }

  wireLinks();
  document.addEventListener("DOMContentLoaded", wireLinks, { once: true });
  window.addEventListener("bd:portal-view", wireLinks);
})();
