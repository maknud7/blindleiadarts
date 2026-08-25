const API_ROOT = "../api/v1";
const PAIRING_URL = "../api/kiosk-pairing.php";
const CREATE_AND_PAIR_URL = "../api/kiosk-pairing-create-board.php";

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
const boardNumberInput = document.getElementById("claimBoardNumber");
const boardNameInput = document.getElementById("claimBoardName");
const sponsorLabelInput = document.getElementById("claimSponsorLabel");
const sponsorLogoUrlInput = document.getElementById("claimSponsorLogoUrl");
const scoringModeSelect = document.getElementById("claimScoringMode");
const scoliaSerialRow = document.getElementById("claimScoliaSerialRow");
const scoliaSerialInput = document.getElementById("claimScoliaSerial");

let boardMode = "new";
let boards = [];
let boardNumberTouched = false;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
function normalizeScoliaId(value) { return String(value || "").trim(); }
function validScoliaId(value) { return /^[A-Za-z0-9._:-]{3,120}$/.test(normalizeScoliaId(value)); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

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
  statusBox.className = `claim-status ${tone}`;
  statusBox.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
}
function hideStatus() { statusBox.className = "claim-status hidden"; statusBox.innerHTML = ""; }

function renderScoliaField() {
  const enabled = boardMode === "new" && scoringModeSelect?.value === "scolia";
  scoliaSerialRow?.classList.toggle("hidden", !enabled);
  if (scoliaSerialInput) scoliaSerialInput.required = enabled;
}

function nextBoardNumber(items) {
  const used = new Set(items.map((board) => Number(board.board_number || 0)).filter((value) => value > 0));
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function setBoardMode(mode) {
  boardMode = mode === "existing" ? "existing" : "new";
  newBoardChoice?.classList.toggle("active", boardMode === "new");
  existingBoardChoice?.classList.toggle("active", boardMode === "existing");
  newBoardFields?.classList.toggle("hidden", boardMode !== "new");
  existingBoardFields?.classList.toggle("hidden", boardMode !== "existing");
  if (boardNumberInput) boardNumberInput.required = boardMode === "new";
  if (boardSelect) boardSelect.required = boardMode === "existing";
  submitButton.textContent = boardMode === "new" ? "Opprett og koble" : "Koble til board";
  renderScoliaField();
}

async function loadBoards() {
  const id = clubId();
  if (!id) return;
  const data = await requestJson(`${API_ROOT}/clubs/${id}/kiosks`);
  boards = data.items || [];
  const available = boards.filter((board) => Number(board.is_paired) !== 1 && Number(board.is_active ?? 1) === 1);

  boardSelect.innerHTML = `<option value="">Velg board …</option>${boards.map((board) => {
    const paired = Number(board.is_paired) === 1;
    const inactive = Number(board.is_active ?? 1) !== 1;
    const unavailable = paired || inactive;
    const sponsor = board.sponsor_label ? ` · ${board.sponsor_label}` : "";
    const suffix = paired ? " · allerede paret" : (inactive ? " · inaktivt" : "");
    const label = `Board ${Number(board.board_number)} · ${board.name || board.code}${sponsor}${suffix}`;
    return `<option value="${Number(board.id)}" ${unavailable ? "disabled" : ""}>${escapeHtml(label)}</option>`;
  }).join("")}`;

  const suggested = nextBoardNumber(boards);
  if (boardNumberInput && (!boardNumberTouched || Number(boardNumberInput.value || 0) <= 0)) boardNumberInput.value = String(suggested);
  if (boardNameInput) boardNameInput.placeholder = `Board ${suggested} eller f.eks. Sjøbua Arena`;

  existingBoardChoice.disabled = available.length === 0;
  existingBoardChoice.title = available.length === 0 ? "Ingen ledige eksisterende boards" : "Bruk et board som allerede finnes";
  if (boardMode === "existing" && available.length === 0) setBoardMode("new");
}

async function inspectCode() {
  const code = normalizeCode(codeInput.value);
  codeInput.value = code;
  if (!code || !clubId() || !token()) { hideStatus(); return null; }
  try {
    const url = new URL(PAIRING_URL, window.location.href);
    url.searchParams.set("action", "admin-info");
    url.searchParams.set("club_id", String(clubId()));
    url.searchParams.set("code", code);
    const data = await requestJson(url, { auth: true });
    const request = data.request || {};
    if (!request.claimable) {
      const text = request.status === "expired" ? "Koden er utløpt. Nettbrettet lager automatisk en ny kode." : `Status: ${request.status || "ukjent"}`;
      showStatus("Denne koden kan ikke kobles", text, "bad");
      return request;
    }
    const actionText = boardMode === "new" ? "Opprett boardet og koble terminalen." : "Velg eksisterende board og koble terminalen.";
    showStatus(request.device_name || "Nytt nettbrett", `Pairingkode ${request.request_code}. ${actionText}`, "warning");
    return request;
  } catch (error) {
    showStatus("Fant ikke pairingkoden", error.message, "bad");
    return null;
  }
}

async function claimExistingTerminal(code) {
  const kioskId = Number(boardSelect.value || 0);
  if (!kioskId) throw new Error("Velg hvilket eksisterende board nettbrettet står ved.");
  const url = new URL(PAIRING_URL, window.location.href);
  url.searchParams.set("action", "claim");
  url.searchParams.set("club_id", String(clubId()));
  return requestJson(url, { method: "POST", auth: true, body: { code, kiosk_id: kioskId } });
}

async function createAndClaimTerminal(code) {
  const boardNumber = Number(boardNumberInput.value || 0);
  if (boardNumber <= 0) throw new Error("Boardnummer må være 1 eller høyere.");
  const scoringMode = String(scoringModeSelect.value || "manual");
  const scoliaSerial = normalizeScoliaId(scoliaSerialInput?.value || "");
  if (scoringMode === "scolia" && !validScoliaId(scoliaSerial)) {
    throw new Error("Scolia-board må ha en gyldig Scolia-ID / serienummer.");
  }

  const url = new URL(CREATE_AND_PAIR_URL, window.location.href);
  url.searchParams.set("club_id", String(clubId()));
  return requestJson(url, {
    method: "POST",
    auth: true,
    body: {
      code,
      board: {
        board_number: boardNumber,
        name: String(boardNameInput.value || "").trim(),
        sponsor_label: String(sponsorLabelInput.value || "").trim(),
        sponsor_logo_url: String(sponsorLogoUrlInput.value || "").trim(),
        scoring_mode: scoringMode,
        scolia_serial_number: scoringMode === "scolia" ? scoliaSerial : null,
      },
    },
  });
}

async function claimTerminal() {
  const code = normalizeCode(codeInput.value);
  if (!code) throw new Error("Skriv inn pairingkoden fra nettbrettet.");
  return boardMode === "new" ? createAndClaimTerminal(code) : claimExistingTerminal(code);
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  try {
    const data = await claimTerminal();
    const kiosk = data.kiosk || {};
    const sponsor = kiosk.sponsor_label ? ` · ${kiosk.sponsor_label}` : "";
    const verb = data.created ? "opprettet og koblet" : "koblet";
    showStatus(`${kiosk.name || `Board ${kiosk.board_number}`} er ${verb}`, `Board ${kiosk.board_number}${sponsor} · ${kiosk.device_name || "Nettbrettet"}`, "good");
    const url = new URL(window.location.href);
    url.searchParams.delete("pairing");
    history.replaceState({}, "", url);
    codeInput.value = "";
    boardNameInput.value = "";
    sponsorLabelInput.value = "";
    sponsorLogoUrlInput.value = "";
    scoringModeSelect.value = "manual";
    if (scoliaSerialInput) scoliaSerialInput.value = "";
    boardNumberTouched = false;
    renderScoliaField();
    await loadBoards();
    setBoardMode("new");
    setTimeout(() => refreshButton?.click(), 250);
  } catch (error) {
    showStatus("Kunne ikke koble terminalen", error.message, "bad");
  } finally { submitButton.disabled = false; }
});

newBoardChoice?.addEventListener("click", async () => { setBoardMode("new"); if (codeInput.value) await inspectCode(); });
existingBoardChoice?.addEventListener("click", async () => { if (existingBoardChoice.disabled) return; setBoardMode("existing"); if (codeInput.value) await inspectCode(); });
boardNumberInput?.addEventListener("input", () => { boardNumberTouched = true; });
codeInput?.addEventListener("input", () => { codeInput.value = normalizeCode(codeInput.value); });
codeInput?.addEventListener("change", () => inspectCode());
scoringModeSelect?.addEventListener("change", renderScoliaField);
clubSelect?.addEventListener("change", async () => {
  boardNumberTouched = false;
  await loadBoards().catch(() => undefined);
  if (codeInput.value) await inspectCode();
});

function adminReady() { return Boolean(token() && clubId() && !document.getElementById("adminApp")?.classList.contains("hidden")); }
async function initializeWhenReady(pairing) {
  if (!adminReady()) { setTimeout(() => initializeWhenReady(pairing), 350); return; }
  setBoardMode("new");
  await loadBoards().catch((error) => showStatus("Kunne ikke laste boards", error.message, "bad"));
  if (pairing) {
    kioskSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    await inspectCode();
  }
}
function bootClaim() {
  const pairing = normalizeCode(new URLSearchParams(window.location.search).get("pairing") || "");
  if (pairing) codeInput.value = pairing;
  renderScoliaField();
  initializeWhenReady(pairing);
}
bootClaim();