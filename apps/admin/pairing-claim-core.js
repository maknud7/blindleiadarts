const API_ROOT = "../api/v1";
const PAIRING_URL = "../api/kiosk-pairing.php";

const form = document.getElementById("claimKioskForm");
const codeInput = document.getElementById("claimKioskCode");
const boardSelect = document.getElementById("claimKioskBoard");
const submitButton = document.getElementById("claimKioskButton");
const statusBox = document.getElementById("claimKioskStatus");
const clubSelect = document.getElementById("clubSelect");
const refreshButton = document.getElementById("refreshAllButton");
const kioskSection = document.getElementById("kiosks");
const newBoardChoice = document.getElementById("claimNewBoardChoice");
const existingBoardChoice = document.getElementById("claimExistingBoardChoice");
const newBoardFields = document.getElementById("claimNewBoardFields");
const existingBoardFields = document.getElementById("claimExistingBoardFields");
const claimCard = form?.closest(".claim-admin-card") || null;

let boards = [];
let inspectedRequest = null;
let inspectedCode = "";
let inspectTimer = null;
let claimCompleted = false;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function selectedBoard() { return boards.find((board) => Number(board.id) === Number(boardSelect?.value || 0)) || null; }

async function requestJson(url, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload.data;
}

function showStatus(title, detail = "", tone = "warning") {
  if (!statusBox) return;
  statusBox.className = `claim-status ${tone}`;
  statusBox.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
}
function hideStatus() {
  if (!statusBox) return;
  statusBox.className = "claim-status hidden";
  statusBox.innerHTML = "";
}

function ensureWizardUi() {
  if (!form) return;
  const intro = form.previousElementSibling;
  intro?.classList.add("claim-admin-intro");

  if (intro && !document.getElementById("claimAdminFlow")) {
    intro.insertAdjacentHTML("beforeend", `
      <div id="claimAdminFlow" class="claim-admin-flow" aria-label="Pairingsteg">
        <div data-claim-step="1" class="active"><span>1</span><p>Finn nettbrettet</p></div>
        <div data-claim-step="2"><span>2</span><p>Velg skive</p></div>
        <div data-claim-step="3"><span>3</span><p>Koble</p></div>
      </div>`);
  }

  if (!document.getElementById("claimDevicePreview")) {
    const codeLabel = codeInput?.closest("label");
    codeLabel?.insertAdjacentHTML("afterend", `
      <div id="claimDevicePreview" class="claim-device-preview hidden">
        <span class="claim-device-icon" aria-hidden="true">▣</span>
        <div><span>Nettbrett funnet</span><strong id="claimDeviceName">—</strong></div>
      </div>`);
  }

  if (existingBoardFields && !document.getElementById("claimBoardTiles")) {
    const selectLabel = boardSelect?.closest("label");
    const tiles = document.createElement("div");
    tiles.id = "claimBoardTiles";
    tiles.className = "claim-board-tiles";
    existingBoardFields.insertBefore(tiles, selectLabel || existingBoardFields.firstChild);

    if (selectLabel && !selectLabel.closest("details")) {
      const details = document.createElement("details");
      details.className = "claim-board-select-fallback";
      const summary = document.createElement("summary");
      summary.textContent = "Vis skiveliste som nedtrekk";
      details.appendChild(summary);
      details.appendChild(selectLabel);
      existingBoardFields.appendChild(details);
    }

    tiles.addEventListener("click", (event) => {
      const button = event.target.closest("[data-claim-board]");
      if (!button || button.disabled || !boardSelect) return;
      boardSelect.value = String(button.dataset.claimBoard || "");
      boardSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

function setStep(step, state) {
  const node = document.querySelector(`[data-claim-step="${step}"]`);
  if (!node) return;
  node.classList.toggle("active", state === "active");
  node.classList.toggle("done", state === "done");
}

function updateWizard() {
  ensureWizardUi();
  const codeReady = Boolean(inspectedRequest && inspectedCode && inspectedRequest.claimable);
  const board = selectedBoard();
  const boardReady = Boolean(board && Number(board.is_paired) !== 1 && Number(board.is_active ?? 1) === 1);

  if (claimCompleted) {
    setStep(1, "done"); setStep(2, "done"); setStep(3, "done");
  } else if (!codeReady) {
    setStep(1, "active"); setStep(2, ""); setStep(3, "");
  } else if (!boardReady) {
    setStep(1, "done"); setStep(2, "active"); setStep(3, "");
  } else {
    setStep(1, "done"); setStep(2, "done"); setStep(3, "active");
  }

  codeInput?.classList.toggle("code-ready", codeReady);
  const devicePreview = document.getElementById("claimDevicePreview");
  const deviceName = document.getElementById("claimDeviceName");
  devicePreview?.classList.toggle("hidden", !codeReady);
  if (deviceName && codeReady) deviceName.textContent = inspectedRequest.device_name || "Nytt nettbrett";

  document.querySelectorAll("[data-claim-board]").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.claimBoard) === Number(boardSelect?.value || 0));
  });

  if (submitButton) {
    submitButton.disabled = claimCompleted || !codeReady || !boardReady;
    submitButton.classList.toggle("ready", codeReady && boardReady && !claimCompleted);
    submitButton.textContent = boardReady ? `Koble til Skive ${Number(board.board_number)}` : "Velg skive";
    if (claimCompleted) submitButton.textContent = "Koblet";
  }
}

function lockToExistingBoard() {
  newBoardChoice?.classList.add("hidden");
  newBoardFields?.classList.add("hidden");
  existingBoardChoice?.classList.add("active");
  existingBoardFields?.classList.remove("hidden");
  if (boardSelect) boardSelect.required = true;
  ensureWizardUi();
  updateWizard();
}

function renderBoardTiles() {
  const root = document.getElementById("claimBoardTiles");
  if (!root) return;
  const active = boards.filter((board) => Number(board.is_active ?? 1) === 1);
  if (!active.length) {
    root.innerHTML = `<div class="empty">Ingen aktive skiver er opprettet.</div>`;
    return;
  }

  root.innerHTML = active.map((board) => {
    const paired = Number(board.is_paired) === 1;
    const number = Number(board.board_number || 0);
    const name = board.name || `Skive ${number}`;
    const detail = paired ? (board.paired_device_name || "Nettbrett koblet") : (board.scoring_mode === "scolia" ? "Scolia · ledig" : "Manuell · ledig");
    return `<button type="button" class="claim-board-tile" data-claim-board="${Number(board.id)}" ${paired ? "disabled" : ""}>
      <span class="claim-board-number">${number}</span>
      <span class="claim-board-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></span>
      <span class="claim-board-state">${paired ? "I bruk" : "Ledig"}</span>
    </button>`;
  }).join("");
}

async function loadBoards() {
  const id = clubId();
  if (!id || !boardSelect) return;
  ensureWizardUi();
  const previousSelection = Number(boardSelect.value || 0);
  const data = await requestJson(`${API_ROOT}/clubs/${id}/kiosks`);
  boards = data.items || [];
  const available = boards.filter((board) => Number(board.is_paired) !== 1 && Number(board.is_active ?? 1) === 1);

  boardSelect.innerHTML = available.length
    ? `<option value="">Velg skive …</option>${available.map((board) => {
        const sponsor = board.sponsor_label ? ` · ${board.sponsor_label}` : "";
        const label = `Skive ${Number(board.board_number)} · ${board.name || board.code}${sponsor}`;
        return `<option value="${Number(board.id)}">${escapeHtml(label)}</option>`;
      }).join("")}`
    : `<option value="">Ingen ledige skiver</option>`;

  if (previousSelection && available.some((board) => Number(board.id) === previousSelection)) {
    boardSelect.value = String(previousSelection);
  } else if (available.length === 1) {
    boardSelect.value = String(available[0].id);
  }

  if (existingBoardChoice) {
    existingBoardChoice.disabled = available.length === 0;
    existingBoardChoice.title = available.length === 0 ? "Ingen ledige skiver" : "Koble terminal til en skive som allerede finnes";
  }

  renderBoardTiles();
  updateWizard();

  if (!claimCompleted && available.length === 0) {
    const hasActive = boards.some((board) => Number(board.is_active ?? 1) === 1);
    showStatus(
      hasActive ? "Alle skivene har allerede nettbrett" : "Ingen aktive skiver",
      hasActive ? "Skal et nettbrett erstattes, åpne den aktuelle skiva og bruk «Bytt nettbrett»." : "Opprett en skive først, og kom tilbake hit for å koble nettbrettet.",
      "warning"
    );
  } else if (!claimCompleted && !codeInput?.value) {
    hideStatus();
  }
}

async function inspectCode() {
  if (!codeInput) return null;
  const code = normalizeCode(codeInput.value);
  codeInput.value = code;
  claimCompleted = false;

  if (!code || !clubId() || !token()) {
    inspectedRequest = null;
    inspectedCode = "";
    updateWizard();
    if (!code) hideStatus();
    return null;
  }

  try {
    const url = new URL(PAIRING_URL, window.location.href);
    url.searchParams.set("action", "admin-info");
    url.searchParams.set("club_id", String(clubId()));
    url.searchParams.set("code", code);
    const data = await requestJson(url, { auth: true });
    const request = data.request || {};
    if (!request.claimable) {
      inspectedRequest = null;
      inspectedCode = "";
      const text = request.status === "expired" ? "Koden er utløpt. Lag en ny kode på nettbrettet." : `Status: ${request.status || "ukjent"}`;
      showStatus("Denne koden kan ikke kobles", text, "bad");
      updateWizard();
      return request;
    }

    inspectedRequest = request;
    inspectedCode = code;
    const board = selectedBoard();
    showStatus(
      "Nettbrettet er funnet",
      board ? `${request.device_name || "Nytt nettbrett"} er klart. Kontroller Skive ${Number(board.board_number)} og koble.` : `${request.device_name || "Nytt nettbrett"} er klart. Velg skiva det står ved.`,
      "good"
    );
    updateWizard();
    return request;
  } catch (error) {
    inspectedRequest = null;
    inspectedCode = "";
    showStatus("Fant ikke pairingkoden", error.message, "bad");
    updateWizard();
    return null;
  }
}

function scheduleInspect() {
  clearTimeout(inspectTimer);
  const code = normalizeCode(codeInput?.value || "");
  if (code.length < 6) {
    inspectedRequest = null;
    inspectedCode = "";
    updateWizard();
    if (code) showStatus("Skriv hele koden", "Pairingkoden står på nettbrettet.", "warning");
    else hideStatus();
    return;
  }
  showStatus("Kontrollerer nettbrettet …", "Et øyeblikk.", "warning");
  inspectTimer = window.setTimeout(() => inspectCode(), 220);
}

async function claimTerminal() {
  const code = normalizeCode(codeInput?.value || "");
  if (!code) throw new Error("Skriv inn pairingkoden fra nettbrettet.");
  if (!inspectedRequest || inspectedCode !== code) {
    const request = await inspectCode();
    if (!request?.claimable) throw new Error("Pairingkoden er ikke klar til bruk.");
  }
  const kioskId = Number(boardSelect?.value || 0);
  if (!kioskId) throw new Error("Velg hvilken skive nettbrettet står ved.");
  const url = new URL(PAIRING_URL, window.location.href);
  url.searchParams.set("action", "claim");
  url.searchParams.set("club_id", String(clubId()));
  return requestJson(url, { method: "POST", auth: true, body: { code, kiosk_id: kioskId } });
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton) submitButton.disabled = true;
  try {
    const data = await claimTerminal();
    const kiosk = data.kiosk || {};
    claimCompleted = true;
    showStatus(
      `Ferdig · ${kiosk.name || `Skive ${kiosk.board_number}`} er koblet`,
      `${kiosk.device_name || "Nettbrettet"} går videre automatisk. Du trenger ikke starte eller laste inn noe på terminalen.`,
      "good"
    );
    updateWizard();

    const url = new URL(window.location.href);
    url.searchParams.delete("pairing");
    history.replaceState({}, "", url);
    window.setTimeout(() => refreshButton?.click(), 250);
    window.setTimeout(async () => {
      if (codeInput) codeInput.value = "";
      inspectedRequest = null;
      inspectedCode = "";
      claimCompleted = false;
      await loadBoards().catch(() => undefined);
      updateWizard();
    }, 2600);
  } catch (error) {
    claimCompleted = false;
    showStatus("Kunne ikke koble nettbrettet", error.message, "bad");
    updateWizard();
  }
});

codeInput?.addEventListener("input", () => {
  codeInput.value = normalizeCode(codeInput.value);
  scheduleInspect();
});
codeInput?.addEventListener("change", () => inspectCode());
boardSelect?.addEventListener("change", () => {
  updateWizard();
  if (inspectedRequest) {
    const board = selectedBoard();
    if (board) showStatus("Klar til å koble", `${inspectedRequest.device_name || "Nettbrettet"} → Skive ${Number(board.board_number)}.`, "good");
  }
});
clubSelect?.addEventListener("change", async () => {
  inspectedRequest = null;
  inspectedCode = "";
  await loadBoards().catch(() => undefined);
  if (codeInput?.value) await inspectCode();
});
refreshButton?.addEventListener("click", () => setTimeout(() => loadBoards().catch(() => undefined), 200));

function adminReady() { return Boolean(token() && clubId() && !document.getElementById("adminApp")?.classList.contains("hidden")); }
async function initializeWhenReady(pairing) {
  if (!adminReady()) { setTimeout(() => initializeWhenReady(pairing), 350); return; }
  lockToExistingBoard();
  await loadBoards().catch((error) => showStatus("Kunne ikke laste skiver", error.message, "bad"));
  if (pairing) {
    claimCard?.classList.add("pairing-from-qr");
    kioskSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    await inspectCode();
  }
}
function bootClaim() {
  ensureWizardUi();
  const pairing = normalizeCode(new URLSearchParams(window.location.search).get("pairing") || "");
  if (pairing && codeInput) codeInput.value = pairing;
  lockToExistingBoard();
  initializeWhenReady(pairing);
}
bootClaim();
