const host = document.getElementById("tournaments");
const MODULE_VERSION = "20260904-admin-load-05";
let requested = false;
let loading = null;
let waitTimer = null;
let liveLoading = null;
let afterLoading = null;
let enhancementLoading = null;
let testToolsLoading = null;

function token() {
  return localStorage.getItem("bd:token") || "";
}

function clubReady() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0) > 0;
}

function adminVisible() {
  return !document.getElementById("adminApp")?.classList.contains("hidden");
}

function tournamentRouteRequested() {
  const hash = String(window.location.hash || "");
  return hash === "#tournaments"
    || hash === "#tournament-admin"
    || hash.endsWith("/tournament-admin")
    || document.body.dataset.portalActive === "tournaments";
}

function moduleUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set("v", MODULE_VERSION);
  return url.href;
}

function isTestEnvironment() {
  return document.documentElement.dataset.appEnv === "test"
    || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
    || /\/test(?:\/|$)/i.test(window.location.pathname)
    || new URLSearchParams(window.location.search).get("pwa") === "test";
}

function ensurePolishCss() {
  if (document.getElementById("tournamentMobilePolish")) return;
  const link = document.createElement("link");
  link.id = "tournamentMobilePolish";
  link.rel = "stylesheet";
  link.href = moduleUrl("./tournament-mobile-polish.css");
  document.head.appendChild(link);
}

function showLoading() {
  if (!host || document.getElementById("tournamentModuleLoading")) return;
  const node = document.createElement("div");
  node.id = "tournamentModuleLoading";
  node.className = "message";
  node.textContent = "Åpner turneringsrom …";
  host.querySelector(":scope > .panel-head")?.insertAdjacentElement("afterend", node);
}

function updateLoading(text) {
  const node = document.getElementById("tournamentModuleLoading");
  if (node) node.textContent = text;
}

function hideLoading() {
  document.getElementById("tournamentModuleLoading")?.remove();
}

function announceToolsReady() {
  window.dispatchEvent(new CustomEvent("bd:tournament-tools-ready", {
    detail: window.__bdTournamentContext || null,
  }));
}

function waitForInitialContext(timeoutMs = 5000) {
  if (window.__bdTournamentContext?.clubId) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("bd:tournament-context", done);
      resolve();
    };
    window.addEventListener("bd:tournament-context", done);
    timer = window.setTimeout(done, timeoutMs);
  });
}

async function primeTournamentPicker() {
  const select = document.getElementById("tcTournament");
  const id = Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
  if (!select || !id || select.options.length > 0) return;

  const url = new URL(`../api/v1/clubs/${id}/registration-tournaments`, import.meta.url);
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) return;

  const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
  if (!items.length || select.options.length > 0) return;

  const selected = Number(select.value || 0);
  const statusLabel = (status) => ({
    draft: "Planlagt",
    ready: "Klar",
    in_progress: "Pågår",
    completed: "Ferdig",
  })[String(status || "")] || String(status || "");

  select.replaceChildren(...items.map((tournament) => {
    const option = document.createElement("option");
    option.value = String(Number(tournament.id));
    option.textContent = `${String(tournament.name || "Turnering")} · ${statusLabel(tournament.status)}`;
    return option;
  }));

  if (items.some((tournament) => Number(tournament.id) === selected)) {
    select.value = String(selected);
  }

  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function loadLiveTools() {
  if (liveLoading) return liveLoading;
  liveLoading = Promise.all([
    import(moduleUrl("./tournament-operations-admin.js")),
    import(moduleUrl("./tournament-playoff-admin.js")),
  ]).then(() => announceToolsReady());
  return liveLoading;
}

async function loadAfterTools() {
  if (afterLoading) return afterLoading;
  afterLoading = import(moduleUrl("./tournament-summary-admin.js"))
    .then(() => announceToolsReady());
  return afterLoading;
}

function loadToolsForContext(context) {
  const view = String(context?.view || "");
  if (view === "live") loadLiveTools().catch(() => undefined);
  if (view === "after") loadAfterTools().catch(() => undefined);
}

function installTestToolsLazyTrigger() {
  if (!isTestEnvironment() || document.getElementById("tcTestTools") || document.getElementById("tcTestToolsLazy")) return;
  const anchor = document.getElementById("tcCheckinSettingsHost") || document.getElementById("tcAddPlayer")?.closest("details");
  if (!anchor) return;

  const placeholder = document.createElement("details");
  placeholder.id = "tcTestToolsLazy";
  placeholder.className = "tc-disclosure";
  placeholder.innerHTML = `<summary>TEST · legg til ekte spillere</summary><div class="tc-disclosure-body"><p class="muted">Åpne verktøyet når du trenger testspillere. Spillerlisten hentes først da, slik at vanlig turneringsadmin slipper ekstra databasekall ved oppstart.</p></div>`;
  if (anchor.id === "tcCheckinSettingsHost") anchor.before(placeholder);
  else anchor.after(placeholder);

  placeholder.addEventListener("toggle", async () => {
    if (!placeholder.open || testToolsLoading) return;
    const body = placeholder.querySelector(".tc-disclosure-body");
    if (body) body.innerHTML = `<p class="muted">Henter TEST-verktøy …</p>`;
    testToolsLoading = import(moduleUrl("./test-tournament-tools.js"));
    try {
      await testToolsLoading;
      const tools = document.getElementById("tcTestTools");
      placeholder.remove();
      if (tools) tools.open = true;
    } catch (error) {
      testToolsLoading = null;
      if (body) body.innerHTML = `<p class="muted">Kunne ikke laste TEST-verktøyet: ${String(error?.message || error)}</p>`;
    }
  });
}

async function loadEnhancements() {
  if (enhancementLoading) return enhancementLoading;
  enhancementLoading = (async () => {
    await Promise.all([
      import(moduleUrl("./tournament-desktop-rail.js")),
      import(moduleUrl("./tournament-delete-admin.js")),
    ]);

    await import(moduleUrl("./tournament-workspace-ux.js"));
    await Promise.all([
      import(moduleUrl("./tournament-canonical-ux.js")),
      import(moduleUrl("./tournament-empty-state.js")),
      import(moduleUrl("./tournament-leader-v2.js")),
      import(moduleUrl("./tournament-admin-focus.js")),
    ]);

    await import(moduleUrl("./tournament-leader-v2-board-state.js"));
    host.dataset.tournamentEnhancements = "ready";
    announceToolsReady();
  })().catch((error) => {
    host.dataset.tournamentEnhancements = "error";
    console.warn("Valgfrie turneringsforbedringer kunne ikke lastes", error);
  });
  return enhancementLoading;
}

function deferEnhancements() {
  const run = () => loadEnhancements();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 700 });
  } else {
    window.setTimeout(run, 120);
  }
}

async function loadModules() {
  if (!host) return;
  if (loading) return loading;

  showLoading();
  ensurePolishCss();
  host.dataset.tournamentModules = "loading";

  loading = (async () => {
    const contextReady = waitForInitialContext();

    // Install the lightweight request observer first so any failed or unusually
    // slow tournament API call is persisted with the authenticated session id.
    await import(moduleUrl("./tournament-diagnostics.js"));

    // tournament-admin creates the canonical workspace DOM and begins its data
    // fetch immediately. Only the modules required to safely operate the room
    // are allowed to block first paint.
    await import(moduleUrl("./tournament-admin.js"));
    updateLoading("Henter turnering …");

    // Prime the picker only as a fallback. tournament-admin normally fills it
    // itself now, without waiting for the player registry.
    primeTournamentPicker().catch(() => undefined);

    await Promise.all([
      import(moduleUrl("./tournament-checkin-admin.js")),
      import(moduleUrl("./tournament-wizard-v2.js")),
      import(moduleUrl("./tournament-flow-ux.js")),
      import(moduleUrl("./tournament-board-selection.js")),
      import(moduleUrl("./tournament-start-format.js")),
      import(moduleUrl("./tournament-format-guard.js")),
    ]);

    installTestToolsLazyTrigger();
    await contextReady;

    host.dataset.tournamentModules = "ready";
    hideLoading();
    announceToolsReady();
    loadToolsForContext(window.__bdTournamentContext);

    // Layout polish, delete tools and the leader overview are useful but must
    // not hold the whole room hostage. Load them after the canonical data is
    // already visible and the browser gets an idle slot.
    deferEnhancements();
  })().catch((error) => {
    host.dataset.tournamentModules = "error";
    hideLoading();
    const message = document.createElement("div");
    message.className = "message error";
    message.textContent = `Turneringsrommet kunne ikke lastes: ${error.message}`;
    host.querySelector(":scope > .panel-head")?.insertAdjacentElement("afterend", message);
    throw error;
  });

  return loading;
}

function tryLoad() {
  if (!requested || !host) return;
  if (token() && clubReady() && adminVisible()) {
    if (waitTimer) {
      window.clearInterval(waitTimer);
      waitTimer = null;
    }
    loadModules().catch(() => undefined);
    return;
  }

  if (!waitTimer) {
    waitTimer = window.setInterval(() => {
      if (token() && clubReady() && adminVisible()) {
        window.clearInterval(waitTimer);
        waitTimer = null;
        loadModules().catch(() => undefined);
      }
    }, 120);
  }
}

function requestTournamentRoom() {
  requested = true;
  tryLoad();
}

window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "tournaments") requestTournamentRoom();
});

window.addEventListener("bd:tournament-context", (event) => {
  loadToolsForContext(event.detail);
});

window.addEventListener("hashchange", () => {
  if (tournamentRouteRequested()) requestTournamentRoom();
});

document.getElementById("clubSelect")?.addEventListener("change", tryLoad);

if (tournamentRouteRequested()) {
  requestTournamentRoom();
}
