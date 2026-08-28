const API_ROOT = "../api/v1";
const PAIRING_URL = "../api/kiosk-pairing.php";

const clubSelect = document.getElementById("clubSelect");
const refreshButton = document.getElementById("refreshAllButton");

let syncTimer = null;
let inspectedCode = "";
let inspectedRequest = null;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function editorBoardId() { return Number(document.getElementById("boardEditorId")?.value || 0); }
function normalizeCode(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function requestJson(url, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function ensureStyles() {
  if (document.getElementById("tabletReplacementStyles")) return;
  const style = document.createElement("style");
  style.id = "tabletReplacementStyles";
  style.textContent = `
    .board-tablet-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-5px 0 15px;padding:0 2px}.board-tablet-actions.hidden{display:none}.board-tablet-actions small{max-width:430px;line-height:1.45}.board-tablet-actions button{white-space:nowrap}
    .tablet-replacement-panel{margin:0 0 15px;padding:15px;border:1px solid rgba(91,170,255,.42);border-radius:14px;background:rgba(91,170,255,.07)}.tablet-replacement-panel.hidden{display:none}.tablet-replacement-panel h4{margin:0 0 5px;font-size:16px}.tablet-replacement-panel p{margin:0}.tablet-replacement-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:13px 0}.tablet-replacement-step{padding:10px;border-radius:10px;background:rgba(255,255,255,.045);font-size:12px;line-height:1.4}.tablet-replacement-step strong{display:block;margin-bottom:3px;color:var(--text)}
    .tablet-replacement-code{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:end;margin-top:12px}.tablet-replacement-code label{display:grid;gap:6px;font-size:13px;color:var(--muted)}.tablet-replacement-code input{width:100%;box-sizing:border-box;font-size:20px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.tablet-replacement-status{margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.04);font-size:12px;line-height:1.45}.tablet-replacement-status.good{border:1px solid rgba(77,212,166,.4)}.tablet-replacement-status.bad{border:1px solid rgba(255,107,107,.45)}.tablet-replacement-status.warning{border:1px solid rgba(245,197,66,.4)}.tablet-replacement-status.hidden{display:none}.tablet-replacement-foot{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:11px}.tablet-replacement-foot small{line-height:1.4}.tablet-replacement-cancel{border:0;background:transparent;color:var(--muted);cursor:pointer;text-decoration:underline}
    @media(max-width:650px){.board-tablet-actions{align-items:stretch;flex-direction:column}.board-tablet-actions button{width:100%}.tablet-replacement-steps{grid-template-columns:1fr}.tablet-replacement-code{grid-template-columns:1fr}.tablet-replacement-code button{width:100%}.tablet-replacement-foot{align-items:flex-start;flex-direction:column}}
  `;
  document.head.appendChild(style);
}

function ensureUi() {
  const device = document.getElementById("boardEditorDevice");
  if (!device || document.getElementById("boardTabletActions")) return;

  device.insertAdjacentHTML("afterend", `
    <div id="boardTabletActions" class="board-tablet-actions hidden">
      <small class="muted">Nettbrettet er bare terminalen. Skive, kamp og historikk blir stående.</small>
      <button id="replaceTabletButton" type="button" class="button secondary">Bytt nettbrett</button>
    </div>
    <section id="tabletReplacementPanel" class="tablet-replacement-panel hidden" aria-label="Bytt nettbrett">
      <h4>Bytt nettbrett uten å stoppe kampen</h4>
      <p class="muted">Det gamle nettbrettet virker helt til du bekrefter byttet. Deretter overtar det nye samme skive og samme serverlagrede kampstatus.</p>
      <div class="tablet-replacement-steps">
        <div class="tablet-replacement-step"><strong>1 · Nytt nettbrett</strong>Åpne Blindleia Kiosk. Det viser en pairingkode.</div>
        <div class="tablet-replacement-step"><strong>2 · Skriv koden</strong>Kontroller at riktig nye enhet blir funnet.</div>
        <div class="tablet-replacement-step"><strong>3 · Bytt og fortsett</strong>Ny terminal overtar med én gang. Ingen kamp restartes.</div>
      </div>
      <div class="tablet-replacement-code">
        <label><span>Pairingkode fra nytt nettbrett</span><input id="replacementPairingCode" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC123"></label>
        <button id="confirmTabletReplacement" type="button" class="button" disabled>Bytt og fortsett</button>
      </div>
      <div id="tabletReplacementStatus" class="tablet-replacement-status hidden"></div>
      <div class="tablet-replacement-foot">
        <small class="muted">Tips: gjør byttet mellom to kast. Alle lagrede kast beholdes; et kast som bare er tastet inn lokalt på gammelt nettbrett følger ikke med.</small>
        <button id="cancelTabletReplacement" type="button" class="tablet-replacement-cancel">Avbryt</button>
      </div>
    </section>`);

  document.getElementById("replaceTabletButton")?.addEventListener("click", openReplacement);
  document.getElementById("cancelTabletReplacement")?.addEventListener("click", closeReplacement);
  document.getElementById("confirmTabletReplacement")?.addEventListener("click", replaceTablet);
  document.getElementById("replacementPairingCode")?.addEventListener("input", handleCodeInput);
}

function setReplacementStatus(text, tone = "warning") {
  const status = document.getElementById("tabletReplacementStatus");
  if (!status) return;
  if (!text) {
    status.textContent = "";
    status.className = "tablet-replacement-status hidden";
    return;
  }
  status.textContent = text;
  status.className = `tablet-replacement-status ${tone}`;
}

function closeReplacement() {
  document.getElementById("tabletReplacementPanel")?.classList.add("hidden");
  const input = document.getElementById("replacementPairingCode");
  if (input) input.value = "";
  inspectedCode = "";
  inspectedRequest = null;
  setReplacementStatus("");
  const confirmButton = document.getElementById("confirmTabletReplacement");
  if (confirmButton) confirmButton.disabled = true;
}

function openReplacement() {
  const panel = document.getElementById("tabletReplacementPanel");
  panel?.classList.remove("hidden");
  inspectedCode = "";
  inspectedRequest = null;
  setReplacementStatus("Nåværende nettbrett er fortsatt aktivt. Skriv koden fra det nye nettbrettet.", "warning");
  const input = document.getElementById("replacementPairingCode");
  if (input) {
    input.value = "";
    window.setTimeout(() => input.focus(), 50);
  }
  const confirmButton = document.getElementById("confirmTabletReplacement");
  if (confirmButton) confirmButton.disabled = true;
}

async function inspectPairingCode(code) {
  const url = new URL(PAIRING_URL, window.location.href);
  url.searchParams.set("action", "admin-info");
  url.searchParams.set("club_id", String(clubId()));
  url.searchParams.set("code", code);
  const data = await requestJson(url);
  const request = data.request || {};
  if (!request.claimable) {
    const detail = request.status === "expired" ? "Koden er utløpt. Lag en ny kode på nettbrettet." : `Koden har status ${request.status || "ukjent"}.`;
    throw new Error(detail);
  }
  return request;
}

function handleCodeInput(event) {
  const input = event.currentTarget;
  const code = normalizeCode(input.value);
  input.value = code;
  inspectedCode = "";
  inspectedRequest = null;
  const confirmButton = document.getElementById("confirmTabletReplacement");
  if (confirmButton) confirmButton.disabled = true;
  clearTimeout(syncTimer);

  if (code.length < 6) {
    setReplacementStatus(code ? "Skriv hele pairingkoden fra det nye nettbrettet." : "Nåværende nettbrett er fortsatt aktivt.", "warning");
    return;
  }

  setReplacementStatus("Kontrollerer pairingkoden …", "warning");
  syncTimer = window.setTimeout(async () => {
    try {
      const request = await inspectPairingCode(code);
      if (normalizeCode(input.value) !== code) return;
      inspectedCode = code;
      inspectedRequest = request;
      setReplacementStatus(`Klar til å bytte til «${request.device_name || "Nytt nettbrett"}». Kamp, leg og lagret score beholdes.`, "good");
      if (confirmButton) confirmButton.disabled = false;
    } catch (error) {
      if (normalizeCode(input.value) !== code) return;
      setReplacementStatus(error.message || "Kunne ikke kontrollere pairingkoden.", "bad");
    }
  }, 250);
}

async function replaceTablet() {
  const kioskId = editorBoardId();
  const input = document.getElementById("replacementPairingCode");
  const code = normalizeCode(input?.value || "");
  const button = document.getElementById("confirmTabletReplacement");
  if (!kioskId || !code) return;

  button.disabled = true;
  setReplacementStatus("Bytter terminal …", "warning");
  try {
    if (inspectedCode !== code || !inspectedRequest) {
      inspectedRequest = await inspectPairingCode(code);
      inspectedCode = code;
    }

    const url = new URL(PAIRING_URL, window.location.href);
    url.searchParams.set("action", "claim");
    url.searchParams.set("club_id", String(clubId()));
    const data = await requestJson(url, {
      method: "POST",
      body: { code, kiosk_id: kioskId, replace_existing: true },
    });
    const kiosk = data.kiosk || {};
    setReplacementStatus(`${kiosk.device_name || inspectedRequest?.device_name || "Det nye nettbrettet"} har overtatt ${kiosk.name || `skive ${kiosk.board_number || ""}`}. Hvis kampen allerede var startet, åpnes samme leg og score automatisk uten «Start kamp».`, "good");

    const message = document.getElementById("boardEditorMessage");
    if (message) {
      message.className = "board-editor-message good";
      message.textContent = "Nettbrettet er byttet. Skive, kampstatus og lagrede kast er beholdt.";
    }

    window.setTimeout(() => {
      refreshButton?.click();
      document.getElementById("boardEditorClose")?.click();
    }, 1200);
  } catch (error) {
    setReplacementStatus(error.message || "Kunne ikke bytte nettbrettet.", "bad");
    button.disabled = false;
  }
}

async function syncEditorTabletAction() {
  ensureUi();
  const backdrop = document.getElementById("boardEditorBackdrop");
  const actions = document.getElementById("boardTabletActions");
  if (!backdrop || !actions || backdrop.classList.contains("hidden")) return;
  const id = editorBoardId();
  if (!id || !clubId() || !token()) return;

  try {
    const data = await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks`);
    const board = (data.items || []).find((item) => Number(item.id) === id);
    const paired = Number(board?.is_paired || 0) === 1;
    actions.classList.toggle("hidden", !paired);
    if (!paired) closeReplacement();
  } catch {
    actions.classList.add("hidden");
  }
}

function scheduleSync(delay = 30) {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => syncEditorTabletAction().catch(() => undefined), delay);
}

function boot() {
  ensureStyles();
  ensureUi();
  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "value"] });
  clubSelect?.addEventListener("change", () => scheduleSync(80));
  refreshButton?.addEventListener("click", () => scheduleSync(250));
  scheduleSync();
}

boot();
