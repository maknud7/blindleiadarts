const host = document.getElementById("tournaments");
const MODULE_VERSION = "20260903-auto-playoff-02";
let requested = false;
let loading = null;
let waitTimer = null;
let liveLoading = null;
let afterLoading = null;

function token() {
  return localStorage.getItem("bd:token") || "";
}

function clubReady() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0) > 0;
}

function adminVisible() {
  return !document.getElementById("adminApp")?.classList.contains("hidden");
}

function moduleUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set("v", MODULE_VERSION);
  return url.href;
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

function hideLoading() {
  document.getElementById("tournamentModuleLoading")?.remove();
}

function announceToolsReady() {
  window.dispatchEvent(new CustomEvent("bd:tournament-tools-ready", {
    detail: window.__bdTournamentContext || null,
  }));
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

async function loadModules() {
  if (!host) return;
  if (loading) return loading;

  showLoading();
  ensurePolishCss();
  host.dataset.tournamentModules = "loading";

  loading = (async () => {
    // tournament-admin creates the canonical workspace DOM. Everything below can
    // start as soon as that shell exists instead of creating a long import waterfall.
    await import(moduleUrl("./tournament-admin.js"));

    await Promise.all([
      import(moduleUrl("./test-tournament-tools.js")),
      import(moduleUrl("./tournament-checkin-admin.js")),
      import(moduleUrl("./tournament-wizard-v2.js")),
      import(moduleUrl("./tournament-flow-ux.js")),
      import(moduleUrl("./tournament-desktop-rail.js")),
      import(moduleUrl("./tournament-board-selection.js")),
      import(moduleUrl("./tournament-delete-admin.js")),
      import(moduleUrl("./tournament-start-format.js")),
    ]);

    // Workspace positioning is the only dependency for the visual/canonical layer.
    await import(moduleUrl("./tournament-workspace-ux.js"));
    await Promise.all([
      import(moduleUrl("./tournament-canonical-ux.js")),
      import(moduleUrl("./tournament-empty-state.js")),
      import(moduleUrl("./tournament-leader-v2.js")),
      import(moduleUrl("./tournament-admin-focus.js")),
    ]);

    // This adapter reads state produced by the leader and board selector, so keep it last.
    await import(moduleUrl("./tournament-leader-v2-board-state.js"));

    host.dataset.tournamentModules = "ready";
    hideLoading();
    announceToolsReady();
    loadToolsForContext(window.__bdTournamentContext);
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
  if (location.hash === "#tournaments") requestTournamentRoom();
});

document.getElementById("clubSelect")?.addEventListener("change", tryLoad);

if (location.hash === "#tournaments" || document.body.dataset.portalActive === "tournaments") {
  requestTournamentRoom();
}
