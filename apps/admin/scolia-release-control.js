const CONTROL_API = "../api/scolia-bridge-control.php";
const stateCache = new Map();
let syncTimer = null;

function authToken() {
  return localStorage.getItem("bd:token") || "";
}

function selectedClubId() {
  return Number(document.getElementById("clubSelect")?.value || localStorage.getItem("bd:selectedClubId") || 0);
}

function cacheKey(clubId, kioskId) {
  return `${clubId}:${kioskId}`;
}

async function requestState(kioskId, { method = "GET", attached } = {}) {
  const clubId = selectedClubId();
  if (!clubId || !kioskId) throw new Error("Mangler klubb eller skive.");
  const url = new URL(CONTROL_API, window.location.href);
  url.searchParams.set("club_id", String(clubId));
  url.searchParams.set("kiosk_id", String(kioskId));
  const headers = { Authorization: `Bearer ${authToken()}` };
  let body;
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ attached: Boolean(attached) });
  }
  const response = await fetch(url, { method, headers, body, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  }
  const state = payload.data?.board || null;
  if (!state) throw new Error("Scolia-status mangler.");
  stateCache.set(cacheKey(clubId, kioskId), { state, loadedAt: Date.now() });
  return state;
}

async function getState(kioskId, force = false) {
  const clubId = selectedClubId();
  const cached = stateCache.get(cacheKey(clubId, kioskId));
  if (!force && cached && Date.now() - cached.loadedAt < 2500) return cached.state;
  return requestState(kioskId);
}

function ensureStyles() {
  if (document.getElementById("scoliaReleaseControlStyles")) return;
  const style = document.createElement("style");
  style.id = "scoliaReleaseControlStyles";
  style.textContent = `
    .scolia-release-quick{white-space:nowrap}
    .scolia-release-quick[data-released="1"]{font-weight:800}
    .scolia-bridge-control-status{margin-top:7px;padding-top:8px;border-top:1px solid var(--line);display:grid;gap:3px}
    .scolia-bridge-control-status strong{color:var(--text)}
    .scolia-bridge-control-status.released strong{font-weight:900}
    .scolia-bridge-prod-note{font-size:12px;color:var(--muted)}
  `;
  document.head.appendChild(style);
}

function editorMessage(text, tone = "good") {
  const message = document.getElementById("boardEditorMessage");
  if (!message) return;
  message.className = `board-editor-message ${tone}`;
  message.textContent = text;
}

function actionCopy(state) {
  if (state.bridge_released) {
    return {
      label: "Koble til Blindleia",
      confirm: "Koble Scolia-skiva tilbake til Blindleia? Blindleia kan da bruke skiva automatisk når den trengs.",
      attached: true,
    };
  }
  return {
    label: "Frikoble Scolia",
    confirm: "Frikoble Scolia fra Blindleia? Blindleia lukker forbindelsen til skiva, slik at den kan brukes direkte i Scolia.",
    attached: false,
  };
}

async function changeOwnership(kioskId, button, currentState) {
  const action = actionCopy(currentState);
  if (!currentState.can_change_bridge) {
    editorMessage("Frikobling av fysisk Scolia gjøres i PROD Utstyr.", "bad");
    return;
  }
  if (!window.confirm(action.confirm)) return;

  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = action.attached ? "Kobler til …" : "Frikobler …";
  try {
    const next = await requestState(kioskId, { method: "POST", attached: action.attached });
    renderAllForBoard(kioskId, next);
    if (next.bridge_released) {
      editorMessage(`Scolia er frikoblet fra Blindleia. Vent opptil ca. ${Number(next.release_effective_within_seconds || 12)} sekunder før du åpner skiva direkte i Scolia.`, "good");
    } else {
      editorMessage("Scolia kan brukes av Blindleia igjen. Tilkobling skjer automatisk når skiva trengs.", "good");
    }
  } catch (error) {
    button.textContent = oldText;
    editorMessage(error.message || "Kunne ikke endre Scolia-frikoblingen.", "bad");
  } finally {
    button.disabled = false;
    scheduleSync(100);
  }
}

function renderQuickButton(row, kioskId, state) {
  let button = row.querySelector(".scolia-release-quick");
  if (!state.is_scolia || !state.can_change_bridge) {
    button?.remove();
    return;
  }
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "board-edit-button scolia-release-quick";
    button.addEventListener("click", async () => {
      const latest = await getState(kioskId, true).catch(() => null);
      if (latest) await changeOwnership(kioskId, button, latest);
    });
    const controls = row.querySelector(".board-controls") || row;
    controls.appendChild(button);
  }
  const action = actionCopy(state);
  button.textContent = action.label;
  button.dataset.released = state.bridge_released ? "1" : "0";
  button.title = state.bridge_released
    ? "Skiva er frikoblet og kan brukes direkte i Scolia."
    : "Slipp Blindleia sin Scolia-forbindelse slik at skiva kan brukes direkte i Scolia.";
}

function renderEditor(kioskId, state) {
  const backdrop = document.getElementById("boardEditorBackdrop");
  if (!backdrop || backdrop.classList.contains("hidden")) return;
  if (Number(document.getElementById("boardEditorId")?.value || 0) !== Number(kioskId)) return;

  const actions = document.getElementById("boardScoliaActions");
  const runtime = document.getElementById("boardScoliaRuntime");
  const save = document.getElementById("boardEditorSave");
  if (!actions || !runtime || !state.is_scolia) return;

  let button = actions.querySelector("[data-scolia-bridge-control]");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.dataset.scoliaBridgeControl = "1";
    button.addEventListener("click", async () => {
      const latest = await getState(kioskId, true).catch((error) => {
        editorMessage(error.message || "Kunne ikke lese Scolia-status.", "bad");
        return null;
      });
      if (latest) await changeOwnership(kioskId, button, latest);
    });
    actions.appendChild(button);
  }

  const action = actionCopy(state);
  button.textContent = state.can_change_bridge ? action.label : (state.bridge_released ? "Koble til i PROD" : "Frikoble i PROD");
  button.disabled = !state.can_change_bridge;
  button.title = state.can_change_bridge ? action.confirm : "Fysisk Scolia-frikobling styres fra PROD Utstyr.";

  actions.querySelectorAll("[data-scolia-action]").forEach((existing) => {
    existing.hidden = Boolean(state.bridge_released);
  });

  let status = runtime.querySelector(".scolia-bridge-control-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "scolia-bridge-control-status";
    runtime.appendChild(status);
  }
  status.classList.toggle("released", Boolean(state.bridge_released));
  status.innerHTML = state.bridge_released
    ? `<strong>Frikoblet fra Blindleia</strong><span class="muted">Skiva kan brukes direkte i Scolia. Serienummer og skiveoppsett er beholdt.</span>${state.can_change_bridge ? `<span class="muted">Koble til Blindleia igjen med knappen under.</span>` : `<span class="scolia-bridge-prod-note">Endres i PROD Utstyr.</span>`}`
    : `<strong>Blindleia kan bruke Scolia</strong><span class="muted">Frikoble skiva her før den skal brukes direkte i Scolia-appen.</span>`;

  // The ordinary board-save path intentionally activates live Scolia. Prevent an
  // unrelated sponsor/name edit from silently reclaiming a deliberately released
  // board; reconnect first, then edit.
  if (save) {
    save.disabled = Boolean(state.bridge_released);
    save.title = state.bridge_released ? "Koble Scolia til Blindleia før du lagrer skiveendringer." : "";
  }
}

function renderAllForBoard(kioskId, state) {
  document.querySelectorAll(`.board-row[data-kiosk-id="${CSS.escape(String(kioskId))}"]`).forEach((row) => {
    renderQuickButton(row, kioskId, state);
  });
  renderEditor(kioskId, state);
}

async function syncRows() {
  const rows = [...document.querySelectorAll("#kioskList .board-row")];
  for (const row of rows) {
    const kioskId = Number(row.dataset.kioskId || row.querySelector("[data-kiosk-id]")?.dataset.kioskId || 0);
    if (!kioskId || row.dataset.scoliaReleaseLoading === "1") continue;
    row.dataset.scoliaReleaseLoading = "1";
    try {
      const state = await getState(kioskId);
      renderQuickButton(row, kioskId, state);
    } catch {
      row.querySelector(".scolia-release-quick")?.remove();
    } finally {
      row.dataset.scoliaReleaseLoading = "0";
    }
  }
}

async function syncEditor() {
  const backdrop = document.getElementById("boardEditorBackdrop");
  if (!backdrop || backdrop.classList.contains("hidden")) return;
  const kioskId = Number(document.getElementById("boardEditorId")?.value || 0);
  if (!kioskId) return;
  try {
    const state = await getState(kioskId);
    renderEditor(kioskId, state);
  } catch {
    // The normal board editor remains usable if this optional control cannot load.
  }
}

function scheduleSync(delay = 80) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void syncRows();
    void syncEditor();
  }, delay);
}

function boot() {
  ensureStyles();
  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-kiosk-id"] });
  document.getElementById("refreshAllButton")?.addEventListener("click", () => {
    stateCache.clear();
    scheduleSync(250);
  });
  document.getElementById("clubSelect")?.addEventListener("change", () => {
    stateCache.clear();
    scheduleSync(250);
  });
  scheduleSync(200);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
