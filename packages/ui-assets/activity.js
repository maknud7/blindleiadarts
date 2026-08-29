(() => {
  if (window.__blindleiaActivityInstalled) return;
  window.__blindleiaActivityInstalled = true;

  const API = new URL("../../api/v1/activity", import.meta?.url || window.location.href);
  const MAX_BATCH = 20;
  const MAX_QUEUE = 50;
  const FLUSH_MS = 30000;
  const MIN_REQUEST_GAP_MS = 30000;
  const BACKOFF_429_MS = 5 * 60 * 1000;
  const DEDUPE_MS = 2000;
  const DEFAULT_CLUB_SLUG = "blindleia-dartklubb";
  const queue = [];
  const recent = new Map();
  let timer = null;
  let inFlight = false;
  let lastRequestAt = 0;
  let pausedUntil = 0;
  let context = { club_id: null, club_slug: null, tournament_id: null };

  function installTestEnvironmentFrame() {
    const hostname = String(window.location.hostname || "").toLowerCase();
    if (!(hostname === "test.blindleiadarts.ingenting.org" || hostname.startsWith("test."))) return;
    if (document.getElementById("bd-test-environment-frame")) return;

    const frame = document.createElement("div");
    frame.id = "bd-test-environment-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:4px solid #f2c94c;box-sizing:border-box;";

    const badge = document.createElement("div");
    badge.textContent = "TEST";
    badge.style.cssText = "position:absolute;top:0;left:50%;transform:translateX(-50%);padding:2px 10px 3px;border-radius:0 0 8px 8px;background:#f2c94c;color:#3b2d00;font:800 11px/1.2 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.08em;box-shadow:0 1px 3px rgba(0,0,0,.12);";
    frame.appendChild(badge);
    document.documentElement.appendChild(frame);
  }

  function surface() {
    const explicit = document.body?.dataset?.activitySurface;
    if (explicit) return explicit;
    if (location.pathname.includes("/admin/")) return "admin";
    if (location.pathname.includes("/player/")) return "player";
    if (location.pathname.includes("/onboarding/")) return "onboarding";
    if (location.pathname.includes("/live/")) return "live";
    if (location.pathname.includes("/screen/")) return "screen";
    if (location.pathname.includes("/kiosk/")) return "kiosk";
    return "site";
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

  function selectedClubSlug() {
    if (context.club_slug) return String(context.club_slug).slice(0, 120);
    const query = new URLSearchParams(location.search).get("club");
    return (query || document.body?.dataset?.clubSlug || DEFAULT_CLUB_SLUG).slice(0, 120);
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

  function eventKey(eventName, metadata) {
    return `${eventName}|${cleanPath()}|${metadata?.portal_view || metadata?.action || metadata?.element_id || ""}`;
  }

  function push(eventName, metadata = {}) {
    const now = Date.now();
    if (now < pausedUntil) return;

    const key = eventKey(eventName, metadata);
    const previousAt = recent.get(key) || 0;
    if (now - previousAt < DEDUPE_MS) return;
    recent.set(key, now);

    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({
      occurred_at: new Date().toISOString(),
      surface: surface(),
      event_name: String(eventName || "event").slice(0, 64),
      path: cleanPath(),
      page_title: document.title.slice(0, 180),
      device_class: deviceClass(),
      referrer_host: referrerHost(),
      club_id: selectedClubId(),
      club_slug: selectedClubSlug(),
      tournament_id: selectedTournamentId(),
      metadata,
    });
    schedule();
  }

  function clearTimer() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
  }

  function schedule(delay = FLUSH_MS) {
    if (timer || inFlight || Date.now() < pausedUntil) return;
    timer = window.setTimeout(() => {
      timer = null;
      flush();
    }, Math.max(1000, delay));
  }

  async function flush({ keepalive = false } = {}) {
    if (!queue.length || inFlight || Date.now() < pausedUntil) return;

    const now = Date.now();
    const wait = MIN_REQUEST_GAP_MS - (now - lastRequestAt);
    if (!keepalive && wait > 0) {
      schedule(wait);
      return;
    }

    inFlight = true;
    clearTimer();
    const events = queue.splice(0, MAX_BATCH);
    const token = localStorage.getItem("bd:token") || "";
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    lastRequestAt = now;

    try {
      const response = await fetch(API.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        cache: "no-store",
        keepalive,
        credentials: "same-origin",
      });

      if (response.status === 429) {
        queue.length = 0;
        pausedUntil = Date.now() + BACKOFF_429_MS;
        return;
      }

      if (!response.ok && !keepalive) {
        console.warn("Activity logging paused after HTTP", response.status);
      }
    } catch (error) {
      if (!keepalive) console.warn("Activity logging unavailable", error);
    } finally {
      inFlight = false;
    }

    if (queue.length) schedule();
  }

  function trackExplicitClick(event) {
    const node = event.target?.closest?.("[data-track]");
    if (!node || node.closest("[data-no-activity]")) return;
    push("action", {
      element_id: node.id || null,
      action: node.dataset.track || null,
    });
  }

  function trackSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.closest("[data-no-activity]")) return;
    push("form_submit", {
      element_id: form.id || null,
      action: form.dataset.track || null,
    });
  }

  window.BlindleiaActivity = {
    track: push,
    flush,
    setContext(next = {}) {
      context = { ...context, ...next };
    },
  };

  document.addEventListener("click", trackExplicitClick, { capture: true, passive: true });
  document.addEventListener("submit", trackSubmit, { capture: true });
  window.addEventListener("bd:portal-view", (event) => push("navigation", { portal_view: event.detail?.target || null }));
  window.addEventListener("pagehide", () => flush({ keepalive: true }));

  installTestEnvironmentFrame();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => push("page_view"), { once: true });
  } else {
    push("page_view");
  }
})();
