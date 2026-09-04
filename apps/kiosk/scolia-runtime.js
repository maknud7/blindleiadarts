const SCOLIA_API_ROOT = "../api/v1";
const TEST_LEASE_API = "../api/kiosk-scolia-test-lease.php";
const card = document.getElementById("scoliaScoring");
const manual = document.getElementById("manualScoring");

const TEST_MODE_KEY = "bd:kioskTestMode";
const TEST_BOARD_ID_KEY = "bd:kioskTestPhysicalBoardId";
const TEST_LEASE_ACTIVE_KEY = "bd:kioskScoliaLeaseActive";
const TEST_LEASE_CODE_KEY = "bd:kioskScoliaLeaseKioskCode";
const TEST_LEASE_PHYSICAL_KEY = "bd:kioskScoliaLeasePhysicalId";
const OFFLINE_FALLBACK_GRACE_MS = 5000;
const OFFLINE_FALLBACK_RETRY_MS = 5000;
const SCOLIA_REQUEST_TIMEOUT_MS = 15000;

let status = null;
let busy = false;
let lastError = "";
let leaseBusy = false;
let leaseHeartbeatTimer = null;
let offlineSince = 0;
let autoFallbackBusy = false;
let autoFallbackRetryAt = 0;

function kioskCode() { return localStorage.getItem("bd:kioskCode") || ""; }
function pairingToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }
function isTestEnvironment() { return document.body?.dataset?.appEnv === "test"; }
function testModeActive() { return localStorage.getItem(TEST_MODE_KEY) === "1"; }
function selectedPhysicalBoardId() { return Number(localStorage.getItem(TEST_BOARD_ID_KEY) || 0); }
function testLeaseActive() { return localStorage.getItem(TEST_LEASE_ACTIVE_KEY) === "1"; }

async function fetchWithTimeout(url, init = {}, timeoutMs = SCOLIA_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function isBoardOffline(board) {
  return String(board?.board_status || "").trim().toLowerCase() === "offline";
}

function isBoardAvailable(board) {
  return board?.connection_state === "connected" && !isBoardOffline(board);
}

function shouldAutoFallback(board) {
  if (!board || board.mode !== "live") return false;
  if (board.effective_scoring_mode !== "scolia") return false;
  if (Number(board.fallback_active || 0) === 1 || Number(board.needs_reconciliation || 0) === 1) return false;
  if (Number(board.auto_fallback_to_manual ?? 1) !== 1) return false;
  return isBoardOffline(board) || board.connection_state === "disconnected" || board.connection_state === "error";
}

async function maybeAutoFallback(board) {
  if (!shouldAutoFallback(board)) {
    offlineSince = 0;
    autoFallbackRetryAt = 0;
    return board;
  }

  const now = Date.now();
  if (!offlineSince) {
    offlineSince = now;
    return board;
  }
  if ((now - offlineSince) < OFFLINE_FALLBACK_GRACE_MS || now < autoFallbackRetryAt || autoFallbackBusy) return board;

  const code = kioskCode();
  if (!code) return board;

  autoFallbackBusy = true;
  try {
    const data = await request(`/kiosks/${encodeURIComponent(code)}/scolia/fallback`, { method: "POST" });
    const nextBoard = data?.board || board;
    if (Number(nextBoard.fallback_active || 0) === 1 || Number(nextBoard.needs_reconciliation || 0) === 1) {
      offlineSince = 0;
      autoFallbackRetryAt = 0;
      lastError = "";
    } else {
      // No active match can legitimately leave fallback inactive. Avoid hammering the endpoint.
      autoFallbackRetryAt = Date.now() + 30000;
    }
    return nextBoard;
  } catch (error) {
    lastError = `Automatisk Scolia-fallback feilet: ${error.message}`;
    autoFallbackRetryAt = Date.now() + OFFLINE_FALLBACK_RETRY_MS;
    return board;
  } finally {
    autoFallbackBusy = false;
  }
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const pairing = pairingToken();
  if (pairing) headers["X-Kiosk-Pairing-Token"] = pairing;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchWithTimeout(`${SCOLIA_API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Scolia-feil (${response.status})`);
  return payload.data;
}

async function leaseRequest(action, body, { keepalive = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  const pairing = pairingToken();
  if (pairing) headers["X-Kiosk-Pairing-Token"] = pairing;
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
    cache: "no-store",
    keepalive,
  };
  const url = `${TEST_LEASE_API}?action=${encodeURIComponent(action)}`;
  const response = keepalive ? await fetch(url, init) : await fetchWithTimeout(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Scolia test-lease feilet (${response.status})`);
    error.code = payload?.error?.code || "scolia_test_lease_failed";
    throw error;
  }
  return payload.data;
}

function rememberLease(physicalId, code) {
  localStorage.setItem(TEST_LEASE_ACTIVE_KEY, "1");
  localStorage.setItem(TEST_LEASE_PHYSICAL_KEY, String(physicalId));
  localStorage.setItem(TEST_LEASE_CODE_KEY, code);
}

function clearLeaseMarker() {
  localStorage.removeItem(TEST_LEASE_ACTIVE_KEY);
  localStorage.removeItem(TEST_LEASE_PHYSICAL_KEY);
  localStorage.removeItem(TEST_LEASE_CODE_KEY);
}

async function releaseTestLease({ keepalive = false } = {}) {
  if (!isTestEnvironment() || !testLeaseActive() || leaseBusy) return;
  const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
  const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
  if (!code || !physicalId || !pairingToken()) {
    clearLeaseMarker();
    return;
  }
  leaseBusy = true;
  try {
    await leaseRequest("release", { test_kiosk_code: code, physical_kiosk_id: physicalId }, { keepalive });
  } catch (error) {
    if (!keepalive) console.warn("Kunne ikke frigi Scolia test-lease:", error.message);
  } finally {
    clearLeaseMarker();
    leaseBusy = false;
  }
}

async function ensureTestLease() {
  if (!isTestEnvironment() || leaseBusy) return;

  const active = testModeActive();
  const physicalId = selectedPhysicalBoardId();
  const code = kioskCode();
  const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
  const storedCode = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";

  if (!active || !physicalId || !code) {
    if (testLeaseActive()) await releaseTestLease();
    return;
  }

  if (testLeaseActive() && storedPhysicalId === physicalId && storedCode === code) return;
  if (testLeaseActive()) await releaseTestLease();

  leaseBusy = true;
  try {
    const data = await leaseRequest("acquire", { test_kiosk_code: code, physical_kiosk_id: physicalId });
    if (!data?.leased) return; // Physical manual boards stay exactly as before.
    rememberLease(physicalId, code);
    lastError = "";
    // The lease endpoint switches the isolated alias from manual to Scolia. The
    // ordinary kiosk polling will pick that state up without touching PROD match data.
    setTimeout(() => refresh().catch(() => undefined), 250);
  } catch (error) {
    lastError = error.message;
    console.warn("Scolia test-lease kunne ikke aktiveres:", error.message);
  } finally {
    leaseBusy = false;
  }
}

async function heartbeatTestLease() {
  if (!isTestEnvironment()) return;
  if (!testLeaseActive()) {
    await ensureTestLease();
    return;
  }
  const code = localStorage.getItem(TEST_LEASE_CODE_KEY) || "";
  const physicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
  const currentPhysicalId = selectedPhysicalBoardId();
  if (!testModeActive() || !code || !physicalId || currentPhysicalId !== physicalId) {
    await releaseTestLease();
    return;
  }
  try {
    await leaseRequest("heartbeat", { test_kiosk_code: code, physical_kiosk_id: physicalId });
  } catch (error) {
    // A suspended PWA can outlive the three-minute lease. Re-acquire cleanly when it wakes.
    clearLeaseMarker();
    lastError = error.message;
    await ensureTestLease();
  }
}

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function dartLabel(dart) {
  if (!dart) return "—";
  if (Number(dart.value) === 0) return "MISS";
  if (dart.value === "BULL") return dart.multiplier === "D" ? "BULL" : "25";
  return `${dart.multiplier === "S" ? "" : dart.multiplier}${dart.value}`;
}

function queueWarning(queue) {
  const failed = Number(queue?.failed || 0);
  const dead = Number(queue?.dead_letter || 0);
  const queued = Number(queue?.queued || 0) + Number(queue?.processing || 0);
  if (dead > 0) return `${dead} event(er) i dead-letter-kø – admin må se på dette.`;
  if (failed > 0) return `${failed} event(er) venter på automatisk retry.`;
  if (queued > 5) return `${queued} event(er) står i kø.`;
  return "";
}

function connectionText(board) {
  if (board.mode === "off") return "Scolia er av for denne skiven.";
  const fallback = Number(board.fallback_active || 0) === 1 || Number(board.needs_reconciliation || 0) === 1;
  if (fallback && isBoardAvailable(board)) return "Scolia er online igjen. Avstem score før automatisk scoring gjenopptas.";
  if (fallback && (isBoardOffline(board) || board.connection_state !== "connected")) return "Scolia er offline. Manuell fallback er aktiv og kampen kan fortsette.";
  if (Number(board.needs_reconciliation) === 1) return "Score må avstemmes før Scolia kan gjenopptas.";
  if (Number(board.fallback_active) === 1) return "Manuell fallback er aktiv. Kampen kan fortsette på nettbrettet.";
  if (board.connection_state === "connected") return `Scolia tilkoblet${board.board_status ? ` · ${board.board_status}` : ""}${board.board_phase ? ` · ${board.board_phase}` : ""}.`;
  if (board.connection_state === "connecting") return "Kobler til Scolia …";
  if (board.connection_state === "error") return `Scolia-feil${board.error_type ? `: ${board.error_type}` : ""}.`;
  return "Scolia er ikke tilkoblet.";
}

function applyVisibility(board) {
  if (!manual || !card) return;
  const isLiveAutomatic = board.mode === "live"
    && board.effective_scoring_mode === "scolia"
    && Number(board.fallback_active) !== 1
    && Number(board.needs_reconciliation) !== 1;
  if (board.mode === "off") return;
  manual.classList.toggle("hidden", isLiveAutomatic);
  card.classList.remove("hidden");
}

function render() {
  if (!card || !status) return;
  const board = status;
  applyVisibility(board);
  const darts = board.buffer?.darts || [];
  const warning = queueWarning(board.queue);
  const modeLabel = board.mode === "shadow" ? "Shadow – manuell score er fortsatt fasit" : board.mode === "live" ? "Live scoring" : "Av";
  const canResume = Number(board.needs_reconciliation) === 1 || Number(board.fallback_active) === 1;
  const available = isBoardAvailable(board);
  const testLeaseLabel = isTestEnvironment() && testLeaseActive()
    ? `<p class="muted" style="font-weight:800">TEST · fysisk Scolia er midlertidig routet til isolert test-runtime.</p>`
    : "";
  card.innerHTML = `
    <div class="scolia-pulse"></div>
    <div style="width:100%;display:grid;gap:10px">
      <div><p class="eyebrow">Scolia · ${esc(modeLabel)}</p><h3>${esc(connectionText(board))}</h3></div>
      ${testLeaseLabel}
      ${darts.length ? `<div class="dart-summary"><span>Pil 1: ${esc(dartLabel(darts[0]))}</span><span>Pil 2: ${esc(dartLabel(darts[1]))}</span><span>Pil 3: ${esc(dartLabel(darts[2]))}</span></div>` : `<p class="muted">Venter på neste registrerte pil fra skiva.</p>`}
      ${warning ? `<p class="muted" style="font-weight:700">⚠ ${esc(warning)}</p>` : ""}
      ${lastError ? `<p class="muted" style="color:#ff9c9c">${esc(lastError)}</p>` : ""}
      <div class="dart-actions" style="flex-wrap:wrap">
        ${darts.length ? `<button type="button" class="ghost-button" data-scolia-action="delete">Slett siste Scolia-pil</button><button type="button" class="ghost-button" data-scolia-action="correct">Korriger siste pil</button>` : ""}
        <button type="button" class="ghost-button" data-scolia-action="reset">Reset Scolia-fase</button>
        ${board.mode === "live" && !canResume ? `<button type="button" class="ghost-button" data-scolia-action="fallback">Fortsett manuelt</button>` : ""}
        ${canResume ? `<button type="button" class="confirm-button" data-scolia-action="resume" ${available ? "" : "disabled"}>Score er avstemt – bruk Scolia igjen</button>` : ""}
      </div>
      ${canResume && !available ? `<p class="muted">Scolia må være online igjen før automatisk scoring kan gjenopptas.</p>` : ""}
      ${canResume && available ? `<p class="muted">Scolia er tilbake, men manuell fallback fortsetter til scoren er kontrollert og Scolia gjenopptas eksplisitt.</p>` : ""}
    </div>`;
  card.querySelectorAll("[data-scolia-action]").forEach((button) => button.addEventListener("click", () => action(button.dataset.scoliaAction).catch((error) => {
    lastError = error.message;
    render();
  })));
}

async function action(name) {
  if (busy) return;
  const code = kioskCode();
  if (!code) return;
  busy = true;
  lastError = "";
  try {
    if (name === "fallback") {
      if (!window.confirm("Fortsette kampen manuelt? Scolia-eventer blir ignorert til score er avstemt og Scolia eksplisitt gjenopptas.")) return;
      await request(`/kiosks/${encodeURIComponent(code)}/scolia/fallback`, { method: "POST" });
    } else if (name === "resume") {
      if (!isBoardAvailable(status)) {
        lastError = "Scolia er fortsatt offline. Vent til skiva er online før du gjenopptar automatisk scoring.";
        return;
      }
      if (!window.confirm("Har du kontrollert at scoren på skjermen er riktig?")) return;
      await request(`/kiosks/${encodeURIComponent(code)}/scolia/resume`, { method: "POST", body: { reconciled: true } });
    } else if (name === "reset") {
      if (!window.confirm("Reset Scolia-fasen? Eventuelle uferdige Scolia-piler i denne visiten blir tømt. Canonical score endres ikke.")) return;
      await request(`/kiosks/${encodeURIComponent(code)}/scolia/reset-phase`, { method: "POST" });
    } else if (name === "delete") {
      await request(`/kiosks/${encodeURIComponent(code)}/scolia/delete-throw`, { method: "POST", body: {} });
    } else if (name === "correct") {
      const darts = status?.buffer?.darts || [];
      if (!darts.length) return;
      const index = darts.length - 1;
      const value = window.prompt("Korriger siste pil. Bruk f.eks. T20, D16, 20, 25, Bull eller None:", dartLabel(darts[index]));
      if (value == null || !value.trim()) return;
      await request(`/kiosks/${encodeURIComponent(code)}/scolia/correct-throw`, { method: "POST", body: { throw_index: index, sector: value.trim() } });
    }
    await refresh();
  } finally {
    busy = false;
  }
}

async function refresh() {
  const code = kioskCode();
  if (!code || !card) return;
  try {
    const data = await request(`/kiosks/${encodeURIComponent(code)}/scolia/status`);
    status = data.board;
    lastError = "";
    status = await maybeAutoFallback(status);
    render();
  } catch (error) {
    // A manual-only board has no Scolia setup yet; leave the normal kiosk UI untouched.
    if (error.message.includes("ikke funnet") || error.message.includes("not found")) return;
    lastError = error.message;
    if (status) render();
  }
}

if (card) {
  ensureTestLease().catch((error) => console.warn("Scolia test-lease init feilet:", error.message));
  if (isTestEnvironment()) {
    leaseHeartbeatTimer = window.setInterval(() => heartbeatTestLease().catch((error) => console.warn("Scolia test-lease heartbeat feilet:", error.message)), 60000);
    window.setInterval(() => ensureTestLease().catch(() => undefined), 5000);
    window.addEventListener("pagehide", () => {
      if (!testLeaseActive()) return;
      const storedPhysicalId = Number(localStorage.getItem(TEST_LEASE_PHYSICAL_KEY) || 0);
      if (!testModeActive() || selectedPhysicalBoardId() !== storedPhysicalId) {
        releaseTestLease({ keepalive: true }).catch(() => undefined);
      }
    });
  }
  window.setInterval(() => refresh().catch(() => undefined), 750);
  refresh().catch(() => undefined);
}
