const host = document.getElementById("tournaments");
const MODULE_VERSION = "20260826-1315";
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
  host.dataset.tournamentModules = "loading";

  loading = (async () => {
    await import(moduleUrl("./tournament-admin.js"));
    await Promise.all([
      import(moduleUrl("./tournament-checkin-admin.js")),
      import(moduleUrl("./tournament-wizard-v2.js")),
      import(moduleUrl("./tournament-flow-ux.js")),
      import(moduleUrl("./tournament-desktop-rail.js")),
      import(moduleUrl("./tournament-board-selection.js")),
    ]);
    await import(moduleUrl("./tournament-workspace-ux.js"));
    await import(moduleUrl("./tournament-canonical-ux.js"));

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
