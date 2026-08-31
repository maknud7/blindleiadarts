import { resolveBoardScoringMode, shouldPersistRuntimeScoring } from "./board-admin-core.mjs?v=20260831-1530";

const API_ROOT = "../api/v1";

const kioskList = document.getElementById("kioskList");
const clubSelect = document.getElementById("clubSelect");
const refreshButton = document.getElementById("refreshAllButton");
const kioskForm = document.getElementById("kioskForm");
const kioskScoringMode = document.getElementById("kioskScoringMode");
const kioskScoliaSerialRow = document.getElementById("kioskScoliaSerialRow");
const kioskScoliaSerial = document.getElementById("kioskScoliaSerial");
const isTestEnvironment = document.documentElement.dataset.appEnv === "test"
  || document.body?.dataset.appEnv === "test"
  || /(^|[.-])test([.-]|$)/i.test(window.location.hostname)
  || /\/test(?:\/|$)/i.test(window.location.pathname);
let canonicalBoardCache = { clubId: 0, promise: null };

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function validScoliaId(value) { return /^[A-Za-z0-9._:-]{3,120}$/.test(String(value || "").trim()); }

async function requestJson(url, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function resetCanonicalBoardCache() {
  canonicalBoardCache = { clubId: 0, promise: null };
}

async function canonicalBoardMap(requestedClubId) {
  if (requestedClubId <= 0) return new Map();
  if (canonicalBoardCache.clubId !== requestedClubId || !canonicalBoardCache.promise) {
    canonicalBoardCache = {
      clubId: requestedClubId,
      promise: requestJson(`${API_ROOT}/clubs/${requestedClubId}/scolia`)
        .then((data) => {
          const boards = new Map();
          for (const board of data?.boards || []) {
            const ids = [Number(board.id || 0), Number(board.runtime_kiosk_id || board.physical_kiosk_id || 0)];
            ids.filter((id) => id > 0).forEach((id) => boards.set(id, board));
          }
          return boards;
        })
        .catch(() => new Map()),
    };
  }
  return canonicalBoardCache.promise;
}

async function syncCanonicalBoardBadge(id, badge) {
  const requestedClubId = clubId();
  const boards = await canonicalBoardMap(requestedClubId);
  if (!badge.isConnected || requestedClubId !== clubId()) return;
  const canonical = boards.get(Number(id));
  if (!canonical) return;
  badge.textContent = resolveBoardScoringMode({}, canonical) === "scolia" ? "Scolia" : "Manuell";
  badge.dataset.configurationScope = canonical.configuration_scope || "";
}

function ensureStyles() {
  if (document.getElementById("boardAdminStyles")) return;
  const style = document.createElement("style");
  style.id = "boardAdminStyles";
  style.textContent = `
    .board-edit-button{border:1px solid var(--line);background:#111821;color:var(--text);border-radius:9px;padding:8px 11px;cursor:pointer;font-weight:700}.board-edit-button:hover{border-color:var(--accent)}
    .board-editor-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px;z-index:1000}.board-editor-backdrop.hidden{display:none}
    .board-editor{width:min(700px,100%);max-height:92vh;overflow:auto;background:#0e151e;border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.5)}
    .board-editor-head{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.board-editor-head h3{margin:3px 0 0}.board-editor-close{border:0;background:transparent;color:var(--muted);font-size:25px;cursor:pointer}
    .board-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.board-editor-grid .wide{grid-column:1/-1}.board-editor label{display:grid;gap:6px;font-size:13px;color:var(--muted)}.board-editor input,.board-editor select{width:100%;box-sizing:border-box}
    .board-editor-device,.board-scolia-runtime{margin:15px 0;padding:12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);display:grid;gap:5px}.board-editor-device strong,.board-scolia-runtime strong{color:var(--text)}
    .board-editor-device.test-terminal{border-color:rgba(245,197,66,.62);background:rgba(245,197,66,.12);box-shadow:inset 4px 0 0 #f5c542}.test-terminal-badge{display:inline-flex;align-items:center;margin-right:7px;padding:3px 7px;border-radius:999px;background:#f5c542;color:#332500;font-size:10px;line-height:1;font-weight:900;letter-spacing:.09em}
    .prod-setting-inline{display:inline-flex;align-items:center;margin-left:6px;padding:2px 6px;border-radius:999px;background:rgba(255,194,92,.18);color:#ffd786;font-size:10px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
    .board-editor-actions{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:18px}.board-editor-actions .right,.board-runtime-actions{display:flex;gap:8px;flex-wrap:wrap}.board-editor-message{margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}.board-editor-message.bad{border-color:rgba(255,107,107,.45)}.board-editor-message.good{border-color:rgba(77,212,166,.4)}
    .board-active-row{display:flex!important;grid-column:1/-1!important;align-items:center;gap:9px!important}.board-active-row input{width:auto!important}.board-source-badge{white-space:nowrap}
    @media(max-width:650px){.board-editor-grid{grid-template-columns:1fr}.board-editor-grid .wide{grid-column:auto}.board-editor-actions{align-items:stretch;flex-direction:column}.board-editor-actions .right{display:grid}}
  `;
  document.head.appendChild(style);
}

function ensureDialog() {
  if (document.getElementById("boardEditorBackdrop")) return;
  const root = document.createElement("div");
  root.id = "boardEditorBackdrop";
  root.className = "board-editor-backdrop hidden";
  root.innerHTML = `
    <section class="board-editor" role="dialog" aria-modal="true" aria-labelledby="boardEditorTitle">
      <div class="board-editor-head"><div><p class="eyebrow">Blindleia-skive</p><h3 id="boardEditorTitle">Rediger skive</h3></div><button id="boardEditorClose" class="board-editor-close" type="button" aria-label="Lukk">×</button></div>
      <form id="boardEditorForm">
        <input id="boardEditorId" type="hidden">
        <div class="board-editor-grid">
          <label><span>Skivenummer</span><input id="boardEditorNumber" type="number" min="1" required></label>
          <label><span>Scoringtype</span><select id="boardEditorScoring"><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label>
          <label id="boardEditorScoliaRow" class="wide hidden"><span>Scolia-ID / serienummer <span class="prod-setting-inline">PROD-innstilling</span></span><input id="boardEditorScoliaSerial" maxlength="120" autocomplete="off" placeholder="ID fra Scolia"><small class="muted">Fysisk serienummer lagres i canonical PROD-utstyrsregister og er felles for TEST og PROD. ID-en må være unik.</small></label>
          <label class="wide"><span>Visningsnavn</span><input id="boardEditorName" maxlength="120" required></label>
          <label class="wide"><span>Sponsor / presentert av</span><input id="boardEditorSponsor" maxlength="150"></label>
          <label class="wide"><span>Sponsorlogo (URL)</span><input id="boardEditorSponsorLogo" type="url" maxlength="255"></label>
          <label class="board-active-row"><input id="boardEditorActive" type="checkbox"><span>Skiva er aktiv og kan brukes til nye kamper</span></label>
        </div>
        <div id="boardEditorDevice" class="board-editor-device"></div>
        <div id="boardScoliaRuntime" class="board-scolia-runtime hidden"></div>
        <div id="boardScoliaActions" class="board-runtime-actions hidden"></div>
        <div class="board-editor-actions">
          <small class="muted">Deaktiver i stedet for å slette. Historiske kamper beholder skivereferansen.</small>
          <div class="right"><button id="boardEditorCancel" type="button" class="button secondary">Avbryt</button><button id="boardEditorSave" type="submit" class="button">Lagre skive</button></div>
        </div>
        <div id="boardEditorMessage" class="board-editor-message hidden"></div>
      </form>
    </section>`;
  document.body.appendChild(root);
  root.addEventListener("click", (event) => { if (event.target === root) closeEditor(); });
  document.getElementById("boardEditorClose")?.addEventListener("click", closeEditor);
  document.getElementById("boardEditorCancel")?.addEventListener("click", closeEditor);
  document.getElementById("boardEditorForm")?.addEventListener("submit", saveEditor);
  document.getElementById("boardEditorScoring")?.addEventListener("change", renderEditorScolia);
  document.getElementById("boardScoliaActions")?.addEventListener("click", handleScoliaAction);
}

function fmt(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(d);
}

function renderEditorScolia() {
  const enabled = document.getElementById("boardEditorScoring")?.value === "scolia";
  document.getElementById("boardEditorScoliaRow")?.classList.toggle("hidden", !enabled);
  const input = document.getElementById("boardEditorScoliaSerial");
  if (input) input.required = enabled;
}

function renderCreateScolia() {
  const enabled = kioskScoringMode?.value === "scolia";
  kioskScoliaSerialRow?.classList.toggle("hidden", !enabled);
  if (kioskScoliaSerial) kioskScoliaSerial.required = enabled;
}

function closeEditor() { document.getElementById("boardEditorBackdrop")?.classList.add("hidden"); }

function runtimeText(board) {
  if (!board) return "Ingen Scolia-status ennå.";
  const state = board.connection_state || "disconnected";
  const boardStatus = board.board_status || "—";
  const phase = board.board_phase || "—";
  const reconcile = Number(board.needs_reconciliation || 0) === 1 ? " · må avstemmes" : "";
  return `Tilkobling: ${state} · Scolia: ${boardStatus} · fase: ${phase}${reconcile}`;
}

async function openEditor(id) {
  const [data, scolia] = await Promise.all([
    requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks`),
    requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}/scolia`).catch(() => ({ board: null })),
  ]);
  const board = (data.items || []).find((item) => Number(item.id) === Number(id));
  if (!board) throw new Error("Skiva finnes ikke lenger.");
  const s = scolia?.board || null;
  const canonicalScoring = resolveBoardScoringMode(board, s);
  const configurationScope = scolia?.configuration_scope || s?.configuration_scope || "";
  const editorForm = document.getElementById("boardEditorForm");
  editorForm.dataset.configurationScope = configurationScope;
  document.getElementById("boardEditorId").value = String(board.id);
  document.getElementById("boardEditorNumber").value = String(board.board_number || "");
  document.getElementById("boardEditorName").value = board.name || `Skive ${board.board_number}`;
  document.getElementById("boardEditorSponsor").value = board.sponsor_label || "";
  document.getElementById("boardEditorSponsorLogo").value = board.sponsor_logo_url || "";
  document.getElementById("boardEditorScoring").value = canonicalScoring;
  document.getElementById("boardEditorScoliaSerial").value = s?.serial_number || "";
  document.getElementById("boardEditorActive").checked = Number(board.is_active ?? 1) === 1;
  document.getElementById("boardEditorTitle").textContent = board.name || `Skive ${board.board_number}`;
  const device = document.getElementById("boardEditorDevice");
  const paired = Number(board.is_paired) === 1;
  const pairedName = String(board.paired_device_name || "");
  const isTestTerminal = paired && pairedName.startsWith("Testmodus ·");
  device.classList.toggle("test-terminal", isTestTerminal);
  device.innerHTML = paired
    ? (isTestTerminal
      ? `<span class="muted">Testterminal koblet til</span><strong><span class="test-terminal-badge">TEST</span>Testmodus</strong><small class="muted">Koblet ${escapeHtml(fmt(board.paired_at))} · sist sett ${escapeHtml(fmt(board.last_seen_at))}</small>`
      : `<span class="muted">Paret nettbrett</span><strong>${escapeHtml(board.paired_device_name || "Nettbrett")}</strong><small class="muted">Paret ${escapeHtml(fmt(board.paired_at))} · sist sett ${escapeHtml(fmt(board.last_seen_at))}</small>`)
    : `<span class="muted">Nettbrett</span><strong>Ikke paret</strong><small class="muted">Et nytt nettbrett kan kobles via QR-pairing.</small>`;
  const runtime = document.getElementById("boardScoliaRuntime");
  const actions = document.getElementById("boardScoliaActions");
  const isScolia = canonicalScoring === "scolia";
  runtime.classList.toggle("hidden", !isScolia);
  actions.classList.toggle("hidden", !isScolia);
  runtime.innerHTML = isScolia ? `<span class="muted">Scolia-status</span><strong>${escapeHtml(s?.serial_number || "Ingen ID")}</strong><small class="muted">${escapeHtml(runtimeText(s))}</small>` : "";
  actions.innerHTML = isScolia ? `<button type="button" class="button secondary" data-scolia-action="fallback">Manuell fallback</button><button type="button" class="button secondary" data-scolia-action="reset-phase">Reset fase</button>${Number(s?.fallback_active || 0) === 1 || Number(s?.needs_reconciliation || 0) === 1 ? `<button type="button" class="button" data-scolia-action="resume">Avstemt – gjenoppta</button>` : ""}` : "";
  renderEditorScolia();
  const message = document.getElementById("boardEditorMessage");
  message.className = "board-editor-message hidden"; message.textContent = "";
  document.getElementById("boardEditorBackdrop").classList.remove("hidden");
}

async function saveEditor(event) {
  event.preventDefault();
  const id = Number(document.getElementById("boardEditorId").value || 0);
  const boardNumber = Number(document.getElementById("boardEditorNumber").value || 0);
  const name = document.getElementById("boardEditorName").value.trim();
  const scoring = document.getElementById("boardEditorScoring").value;
  const serial = document.getElementById("boardEditorScoliaSerial").value.trim();
  if (!id || boardNumber <= 0 || !name) return;
  if (scoring === "scolia" && !validScoliaId(serial)) {
    const message = document.getElementById("boardEditorMessage");
    message.className = "board-editor-message bad"; message.textContent = "Scolia-skiva må ha en gyldig Scolia-ID / serienummer.";
    return;
  }
  const save = document.getElementById("boardEditorSave");
  const message = document.getElementById("boardEditorMessage");
  save.disabled = true;
  try {
    await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}/scolia`, { method: "PATCH", body: scoring === "scolia"
      ? { serial_number: serial, mode: "live", auto_fallback_to_manual: true }
      : { mode: "off" }
    });
    const kioskBody = {
      board_number: boardNumber,
      name,
      sponsor_label: document.getElementById("boardEditorSponsor").value.trim(),
      sponsor_logo_url: document.getElementById("boardEditorSponsorLogo").value.trim(),
      is_active: document.getElementById("boardEditorActive").checked ? 1 : 0,
    };
    const configurationScope = document.getElementById("boardEditorForm")?.dataset.configurationScope || "";
    if (shouldPersistRuntimeScoring({ isTestEnvironment, configurationScope })) {
      kioskBody.scoring_mode = scoring;
    }
    await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}`, { method: "PATCH", body: kioskBody });
    resetCanonicalBoardCache();
    message.className = "board-editor-message good"; message.textContent = "Skiva er lagret.";
    setTimeout(() => { closeEditor(); refreshButton?.click(); }, 450);
  } catch (error) {
    message.className = "board-editor-message bad"; message.textContent = error.message;
  } finally { save.disabled = false; }
}

async function handleScoliaAction(event) {
  const button = event.target.closest("[data-scolia-action]");
  if (!button) return;
  const id = Number(document.getElementById("boardEditorId").value || 0);
  if (!id) return;
  const action = button.dataset.scoliaAction;
  if (action === "fallback" && !confirm("Aktivere manuell fallback for denne skiva?")) return;
  if (action === "resume" && !confirm("Bekrefter du at scoren er kontrollert og riktig?")) return;
  if (action === "reset-phase" && !confirm("Reset Scolia-fasen? Canonical score endres ikke.")) return;
  button.disabled = true;
  try {
    await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}/scolia/${action}`, { method: "POST" });
    await openEditor(id);
  } catch (error) {
    const message = document.getElementById("boardEditorMessage");
    message.className = "board-editor-message bad"; message.textContent = error.message;
  } finally { button.disabled = false; }
}

function decorateRows() {
  kioskList?.querySelectorAll(".board-row").forEach((row) => {
    let source = row.querySelector("[data-kiosk-id]");
    const id = Number(source?.dataset?.kioskId || row.dataset.kioskId || 0);
    if (!id) return;
    row.dataset.kioskId = String(id);
    if (source?.classList.contains("scoring-mode")) {
      const label = source.value === "scolia" ? "Scolia" : "Manuell";
      const badge = document.createElement("span");
      badge.className = "badge neutral board-source-badge";
      badge.textContent = label;
      badge.dataset.kioskId = String(id);
      source.replaceWith(badge);
      source = badge;
      void syncCanonicalBoardBadge(id, badge);
    }
    if (row.querySelector(".board-edit-button")) return;
    const controls = row.querySelector(".board-controls") || row;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-edit-button";
    button.textContent = "Rediger";
    button.addEventListener("click", () => openEditor(id).catch((error) => window.alert(error.message)));
    controls.appendChild(button);
  });
}

async function createStandaloneScoliaBoard(event) {
  if (kioskScoringMode?.value !== "scolia") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const form = new FormData(kioskForm);
  const boardNumber = Number(form.get("board_number") || 0);
  const serial = String(form.get("scolia_serial_number") || "").trim();
  if (boardNumber <= 0) return;
  if (!validScoliaId(serial)) { alert("Scolia-skiva må ha en gyldig Scolia-ID / serienummer."); return; }
  const submit = kioskForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const created = await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks`, { method: "POST", body: {
      board_number: boardNumber,
      name: String(form.get("name") || "").trim() || `Skive ${boardNumber}`,
      scoring_mode: "scolia",
    }});
    const id = Number(created.kiosk?.id || 0);
    if (!id) throw new Error("Skiva ble opprettet uten gyldig ID.");
    await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}/scolia`, { method: "PATCH", body: { serial_number: serial, mode: "live", auto_fallback_to_manual: true } });
    kioskForm.reset();
    renderCreateScolia();
    refreshButton?.click();
  } catch (error) { alert(error.message); }
  finally { submit.disabled = false; }
}

ensureStyles();
ensureDialog();
const observer = new MutationObserver(decorateRows);
if (kioskList) observer.observe(kioskList, { childList: true, subtree: true });
decorateRows();
kioskScoringMode?.addEventListener("change", renderCreateScolia);
kioskForm?.addEventListener("submit", createStandaloneScoliaBoard, true);
refreshButton?.addEventListener("click", resetCanonicalBoardCache);
clubSelect?.addEventListener("change", resetCanonicalBoardCache);
renderCreateScolia();

const kioskIntro = document.querySelector("#kiosks .panel-head .muted");
if (kioskIntro) kioskIntro.textContent = "Alt som gjelder skiva ligger her. Scolia-ID og fysisk scoringtype er PROD-innstillinger som deles av TEST og PROD.";
