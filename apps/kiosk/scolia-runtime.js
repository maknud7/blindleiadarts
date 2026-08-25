const API_ROOT = "../api/v1";
const card = document.getElementById("scoliaScoring");
const manual = document.getElementById("manualScoring");

let status = null;
let busy = false;
let lastError = "";

function kioskCode() { return localStorage.getItem("bd:kioskCode") || ""; }
function pairingToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const pairing = pairingToken();
  if (pairing) headers["X-Kiosk-Pairing-Token"] = pairing;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Scolia-feil (${response.status})`);
  return payload.data;
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
  const connected = board.connection_state === "connected";
  card.innerHTML = `
    <div class="scolia-pulse"></div>
    <div style="width:100%;display:grid;gap:10px">
      <div><p class="eyebrow">Scolia · ${esc(modeLabel)}</p><h3>${esc(connectionText(board))}</h3></div>
      ${darts.length ? `<div class="dart-summary"><span>Pil 1: ${esc(dartLabel(darts[0]))}</span><span>Pil 2: ${esc(dartLabel(darts[1]))}</span><span>Pil 3: ${esc(dartLabel(darts[2]))}</span></div>` : `<p class="muted">Venter på neste registrerte pil fra skiva.</p>`}
      ${warning ? `<p class="muted" style="font-weight:700">⚠ ${esc(warning)}</p>` : ""}
      ${lastError ? `<p class="muted" style="color:#ff9c9c">${esc(lastError)}</p>` : ""}
      <div class="dart-actions" style="flex-wrap:wrap">
        ${darts.length ? `<button type="button" class="ghost-button" data-scolia-action="delete">Slett siste Scolia-pil</button><button type="button" class="ghost-button" data-scolia-action="correct">Korriger siste pil</button>` : ""}
        <button type="button" class="ghost-button" data-scolia-action="reset">Reset Scolia-fase</button>
        ${board.mode === "live" && !canResume ? `<button type="button" class="ghost-button" data-scolia-action="fallback">Fortsett manuelt</button>` : ""}
        ${canResume ? `<button type="button" class="confirm-button" data-scolia-action="resume" ${connected ? "" : "disabled"}>Score er avstemt – bruk Scolia igjen</button>` : ""}
      </div>
      ${canResume && !connected ? `<p class="muted">Scolia må være tilkoblet igjen før automatisk scoring kan gjenopptas.</p>` : ""}
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
    render();
  } catch (error) {
    // A manual-only board has no Scolia setup yet; leave the normal kiosk UI untouched.
    if (error.message.includes("ikke funnet") || error.message.includes("not found")) return;
    lastError = error.message;
    if (status) render();
  }
}

if (card) {
  window.setInterval(() => refresh().catch(() => undefined), 750);
  refresh().catch(() => undefined);
}
