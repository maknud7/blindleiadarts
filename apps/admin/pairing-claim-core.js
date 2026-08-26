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

let boards = [];

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
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
  if (!statusBox) return;
  statusBox.className = `claim-status ${tone}`;
  statusBox.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
}
function hideStatus() {
  if (!statusBox) return;
  statusBox.className = "claim-status hidden";
  statusBox.innerHTML = "";
}

function lockToExistingBoard() {
  newBoardChoice?.classList.add("hidden");
  newBoardFields?.classList.add("hidden");
  existingBoardChoice?.classList.add("active");
  existingBoardFields?.classList.remove("hidden");
  if (boardSelect) boardSelect.required = true;
  if (submitButton) submitButton.textContent = "Koble nettbrett";
}

async function loadBoards() {
  const id = clubId();
  if (!id || !boardSelect) return;
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

  if (available.length === 1) boardSelect.value = String(available[0].id);
  if (existingBoardChoice) {
    existingBoardChoice.disabled = available.length === 0;
    existingBoardChoice.title = available.length === 0 ? "Opprett en skive først" : "Koble terminal til en skive som allerede finnes";
  }
  if (submitButton) submitButton.disabled = available.length === 0;

  if (available.length === 0) {
    showStatus("Opprett en skive først", "Nettbrettet kobles til en eksisterende skive. Bruk «+ Ny skive», og åpne deretter denne flyten igjen.", "warning");
  } else if (!codeInput?.value) {
    hideStatus();
  }
}

async function inspectCode() {
  if (!codeInput) return null;
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
    showStatus(request.device_name || "Nytt nettbrett", `Pairingkode ${request.request_code}. Velg skiva nettbrettet står ved.`, "warning");
    return request;
  } catch (error) {
    showStatus("Fant ikke pairingkoden", error.message, "bad");
    return null;
  }
}

async function claimTerminal() {
  const code = normalizeCode(codeInput?.value || "");
  if (!code) throw new Error("Skriv inn pairingkoden fra nettbrettet.");
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
    const sponsor = kiosk.sponsor_label ? ` · ${kiosk.sponsor_label}` : "";
    showStatus(`${kiosk.name || `Skive ${kiosk.board_number}`} er koblet`, `Skive ${kiosk.board_number}${sponsor} · ${kiosk.device_name || "Nettbrettet"}`, "good");
    const url = new URL(window.location.href);
    url.searchParams.delete("pairing");
    history.replaceState({}, "", url);
    if (codeInput) codeInput.value = "";
    await loadBoards();
    setTimeout(() => refreshButton?.click(), 250);
  } catch (error) {
    showStatus("Kunne ikke koble nettbrettet", error.message, "bad");
  } finally {
    if (submitButton && boards.some((board) => Number(board.is_paired) !== 1 && Number(board.is_active ?? 1) === 1)) {
      submitButton.disabled = false;
    }
  }
});

codeInput?.addEventListener("input", () => { codeInput.value = normalizeCode(codeInput.value); });
codeInput?.addEventListener("change", () => inspectCode());
clubSelect?.addEventListener("change", async () => {
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
    kioskSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    await inspectCode();
  }
}
function bootClaim() {
  const pairing = normalizeCode(new URLSearchParams(window.location.search).get("pairing") || "");
  if (pairing && codeInput) codeInput.value = pairing;
  lockToExistingBoard();
  initializeWhenReady(pairing);
}
bootClaim();
