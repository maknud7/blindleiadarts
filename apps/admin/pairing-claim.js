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
    throw error;
  }
  return payload.data;
}

function showStatus(title, detail = "", tone = "warning") {
  statusBox.className = `claim-status ${tone}`;
  statusBox.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
}
function hideStatus() { statusBox.className = "claim-status hidden"; statusBox.innerHTML = ""; }

async function loadBoards() {
  const id = clubId();
  if (!id) return;
  const data = await requestJson(`${API_ROOT}/clubs/${id}/kiosks`);
  const boards = data.items || [];
  boardSelect.innerHTML = `<option value="">Velg board …</option>${boards.map((board) => {
    const paired = Number(board.is_paired) === 1;
    const label = `Board ${Number(board.board_number)} · ${board.name || board.code}${paired ? " · allerede paret" : ""}`;
    return `<option value="${Number(board.id)}" ${paired ? "disabled" : ""}>${escapeHtml(label)}</option>`;
  }).join("")}`;
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
      const text = request.status === "expired" ? "Koden er utløpt. Lag en ny kode på nettbrettet." : `Status: ${request.status || "ukjent"}`;
      showStatus("Denne koden kan ikke kobles", text, "bad");
      return request;
    }
    showStatus(request.device_name || "Nytt nettbrett", `Pairingkode ${request.request_code}. Velg board og koble til.`, "warning");
    return request;
  } catch (error) {
    showStatus("Fant ikke pairingkoden", error.message, "bad");
    return null;
  }
}

async function claimTerminal() {
  const code = normalizeCode(codeInput.value);
  const kioskId = Number(boardSelect.value || 0);
  if (!code) throw new Error("Skriv inn pairingkoden fra nettbrettet.");
  if (!kioskId) throw new Error("Velg hvilket board nettbrettet står ved.");

  const url = new URL(PAIRING_URL, window.location.href);
  url.searchParams.set("action", "claim");
  url.searchParams.set("club_id", String(clubId()));
  return requestJson(url, { method: "POST", auth: true, body: { code, kiosk_id: kioskId } });
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  try {
    const data = await claimTerminal();
    const kiosk = data.kiosk || {};
    showStatus("Terminalen er koblet", `${kiosk.device_name || "Nettbrettet"} er nå fast Board ${kiosk.board_number}.`, "good");
    const url = new URL(window.location.href);
    url.searchParams.delete("pairing");
    history.replaceState({}, "", url);
    await loadBoards();
    setTimeout(() => refreshButton?.click(), 250);
  } catch (error) {
    showStatus("Kunne ikke koble terminalen", error.message, "bad");
  } finally {
    submitButton.disabled = false;
  }
});

codeInput?.addEventListener("input", () => {
  codeInput.value = normalizeCode(codeInput.value);
});
codeInput?.addEventListener("change", () => inspectCode());
clubSelect?.addEventListener("change", async () => {
  await loadBoards().catch(() => undefined);
  if (codeInput.value) await inspectCode();
});

async function waitForAdminReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (token() && clubId() && !document.getElementById("adminApp")?.classList.contains("hidden")) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function bootClaim() {
  const pairing = normalizeCode(new URLSearchParams(window.location.search).get("pairing") || "");
  if (pairing) codeInput.value = pairing;

  const ready = await waitForAdminReady();
  if (!ready) return;

  await loadBoards().catch((error) => showStatus("Kunne ikke laste boards", error.message, "bad"));
  if (pairing) {
    kioskSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    await inspectCode();
    if (boardSelect.options.length === 2 && !boardSelect.options[1].disabled) boardSelect.selectedIndex = 1;
  }
}

bootClaim();
