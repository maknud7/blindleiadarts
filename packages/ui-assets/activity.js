(() => {
  const API = new URL("../../api/v1/activity", import.meta?.url || window.location.href);
  const MAX_BATCH = 25;
  const FLUSH_MS = 4000;
  const queue = [];
  let timer = null;
  let context = { club_id: null, tournament_id: null };

  function surface() {
    const explicit = document.body?.dataset?.activitySurface;
    if (explicit) return explicit;
    const segment = location.pathname.split("/").filter(Boolean).pop() || "home";
    const known = ["admin", "player", "onboarding", "live", "screen", "kiosk"];
    return known.includes(segment) ? segment : (location.pathname.includes("/admin/") ? "admin" : location.pathname.includes("/player/") ? "player" : "site");
  }

  function deviceClass() {
    const width = Math.min(window.innerWidth || 0, window.screen?.width || 9999);
    if (width <= 640) return "mobile";
    if (width <= 1100) return "tablet";
    return "desktop";
  }

  function referrerHost() {
    if (!document.referrer) return null;
    try { return new URL(document.referrer).host.slice(0, 190); }
    catch { return null; }
  }

  function selectedClubId() {
    const direct = Number(context.club_id || 0);
    if (direct > 0) return direct;
    const selected = Number(localStorage.getItem("bd:selectedClubId") || document.getElementById("clubSelect")?.value || 0);
    return selected > 0 ? selected : null;
  }

  function selectedTournamentId() {
    const direct = Number(context.tournament_id || 0);
    if (direct > 0) return direct;
    const selected = Number(localStorage.getItem("bd:adminTournamentId") || 0);
    return selected > 0 ? selected : null;
  }

  function cleanPath() {
    return `${location.pathname}${location.hash || ""}`.slice(0, 255);
  }

  function push(eventName, metadata = {}) {
    queue.push({
      occurred_at: new Date().toISOString(),
      surface: surface(),
      event_name: String(eventName || "event").slice(0, 64),
      path: cleanPath(),
      page_title: document.title.slice(0, 180),
      device_class: deviceClass(),
      referrer_host: referrerHost(),
      club_id: selectedClubId(),
      tournament_id: selectedTournamentId(),
      metadata,
    });
    if (queue.length >= MAX_BATCH) flush();
    else schedule();
  }

  function schedule() {
    if (timer) return;
    timer = window.setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  }

  async function flush({ keepalive = false } = {}) {
    if (!queue.length) return;
    const events = queue.splice(0, MAX_BATCH);
    const token = localStorage.getItem("bd:token") || "";
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch(API.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        cache: "no-store",
        keepalive,
        credentials: "same-origin",
      });
      if (!response.ok && !keepalive) console.warn("Activity logging failed", response.status);
    } catch (error) {
      if (!keepalive) console.warn("Activity logging unavailable", error);
    }
    if (queue.length) schedule();
  }

  function sameOriginPath(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      return url.origin === location.origin ? `${url.pathname}${url.hash || ""}`.slice(0, 180) : null;
    } catch { return null; }
  }

  function trackClick(event) {
    const node = event.target?.closest?.("button,a,[role=button]");
    if (!node || node.closest("[data-no-activity]") || node.dataset.noActivity !== undefined) return;
    if (surface() === "kiosk" && node.matches("[data-key],[data-multiplier],[data-special],#numberGrid button")) return;
    push("click", {
      element_id: node.id || null,
      element_tag: node.tagName?.toLowerCase?.() || null,
      action: node.dataset.track || node.name || null,
      href_path: node.tagName === "A" ? sameOriginPath(node.getAttribute("href")) : null,
    });
  }

  function trackSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.closest("[data-no-activity]")) return;
    push("form_submit", { element_id: form.id || null, element_tag: "form", action: form.dataset.track || null });
  }

  window.BlindleiaActivity = {
    track: push,
    flush,
    setContext(next = {}) {
      context = { ...context, ...next };
    },
  };

  document.addEventListener("click", trackClick, { capture: true, passive: true });
  document.addEventListener("submit", trackSubmit, { capture: true });
  window.addEventListener("hashchange", () => push("navigation", { portal_view: location.hash.slice(1) || "home" }));
  window.addEventListener("bd:portal-view", (event) => push("navigation", { portal_view: event.detail?.target || null }));
  window.addEventListener("pagehide", () => flush({ keepalive: true }));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => push("page_view"), { once: true });
  } else {
    push("page_view");
  }
})();