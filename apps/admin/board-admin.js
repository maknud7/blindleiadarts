const API_ROOT = "../api/v1";

const kioskList = document.getElementById("kioskList");
const clubSelect = document.getElementById("clubSelect");
const refreshButton = document.getElementById("refreshAllButton");

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

async function requestJson(url, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureStyles() {
  if (document.getElementById("boardAdminStyles")) return;
  const style = document.createElement("style");
  style.id = "boardAdminStyles";
  style.textContent = `
    .board-edit-button{border:1px solid var(--line);background:#111821;color:var(--text);border-radius:9px;padding:8px 11px;cursor:pointer;font-weight:700}
    .board-edit-button:hover{border-color:var(--accent)}
    .board-editor-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px;z-index:1000}
    .board-editor-backdrop.hidden{display:none}
    .board-editor{width:min(660px,100%);max-height:92vh;overflow:auto;background:#0e151e;border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.5)}
    .board-editor-head{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.board-editor-head h3{margin:3px 0 0}
    .board-editor-close{border:0;background:transparent;color:var(--muted);font-size:25px;cursor:pointer}
    .board-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.board-editor-grid .wide{grid-column:1/-1}
    .board-editor label{display:grid;gap:6px;font-size:13px;color:var(--muted)}.board-editor input,.board-editor select{width:100%;box-sizing:border-box}
    .board-editor-device{margin:15px 0;padding:12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);display:grid;gap:5px}.board-editor-device strong{color:var(--text)}
    .board-editor-actions{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:18px}.board-editor-actions .right{display:flex;gap:8px}
    .board-editor-message{margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}.board-editor-message.bad{border-color:rgba(255,107,107,.45)}.board-editor-message.good{border-color:rgba(77,212,166,.4)}
    .board-active-row{display:flex!important;grid-column:1/-1!important;align-items:center;gap:9px!important}.board-active-row input{width:auto!important}
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
      <div class="board-editor-head"><div><p class="eyebrow">Blindleia-board</p><h3 id="boardEditorTitle">Rediger board</h3></div><button id="boardEditorClose" class="board-editor-close" type="button" aria-label="Lukk">×</button></div>
      <form id="boardEditorForm">
        <input id="boardEditorId" type="hidden">
        <div class="board-editor-grid">
          <label><span>Boardnummer</span><input id="boardEditorNumber" type="number" min="1" required></label>
          <label><span>Scoring</span><select id="boardEditorScoring"><option value="manual">Manuell</option><option value="scolia">Scolia</option></select></label>
          <label class="wide"><span>Visningsnavn</span><input id="boardEditorName" maxlength="120" required></label>
          <label class="wide"><span>Sponsor / presentert av</span><input id="boardEditorSponsor" maxlength="150"></label>
          <label class="wide"><span>Sponsorlogo (URL)</span><input id="boardEditorSponsorLogo" type="url" maxlength="255"></label>
          <label class="board-active-row"><input id="boardEditorActive" type="checkbox"><span>Boardet er aktivt og kan brukes til nye kamper</span></label>
        </div>
        <div id="boardEditorDevice" class="board-editor-device"></div>
        <div class="board-editor-actions">
          <small class="muted">Deaktiver i stedet for å slette. Historiske kamper beholder boardreferansen.</small>
          <div class="right"><button id="boardEditorCancel" type="button" class="button secondary">Avbryt</button><button id="boardEditorSave" type="submit" class="button">Lagre board</button></div>
        </div>
        <div id="boardEditorMessage" class="board-editor-message hidden"></div>
      </form>
    </section>`;
  document.body.appendChild(root);
  root.addEventListener("click", (event) => { if (event.target === root) closeEditor(); });
  document.getElementById("boardEditorClose")?.addEventListener("click", closeEditor);
  document.getElementById("boardEditorCancel")?.addEventListener("click", closeEditor);
  document.getElementById("boardEditorForm")?.addEventListener("submit", saveEditor);
}

function fmt(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(d);
}

function closeEditor() { document.getElementById("boardEditorBackdrop")?.classList.add("hidden"); }

async function openEditor(id) {
  const data = await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks`);
  const board = (data.items || []).find((item) => Number(item.id) === Number(id));
  if (!board) throw new Error("Boardet finnes ikke lenger.");
  document.getElementById("boardEditorId").value = String(board.id);
  document.getElementById("boardEditorNumber").value = String(board.board_number || "");
  document.getElementById("boardEditorName").value = board.name || `Board ${board.board_number}`;
  document.getElementById("boardEditorSponsor").value = board.sponsor_label || "";
  document.getElementById("boardEditorSponsorLogo").value = board.sponsor_logo_url || "";
  document.getElementById("boardEditorScoring").value = board.scoring_mode === "scolia" ? "scolia" : "manual";
  document.getElementById("boardEditorActive").checked = Number(board.is_active ?? 1) === 1;
  document.getElementById("boardEditorTitle").textContent = board.name || `Board ${board.board_number}`;
  document.getElementById("boardEditorDevice").innerHTML = Number(board.is_paired) === 1
    ? `<span class="muted">Paret nettbrett</span><strong>${escapeHtml(board.paired_device_name || "Nettbrett")}</strong><small class="muted">Paret ${escapeHtml(fmt(board.paired_at))} · sist sett ${escapeHtml(fmt(board.last_seen_at))}</small>`
    : `<span class="muted">Nettbrett</span><strong>Ikke paret</strong><small class="muted">Et nytt nettbrett kan kobles via QR-pairing.</small>`;
  const message = document.getElementById("boardEditorMessage");
  message.className = "board-editor-message hidden"; message.textContent = "";
  document.getElementById("boardEditorBackdrop").classList.remove("hidden");
}

async function saveEditor(event) {
  event.preventDefault();
  const id = Number(document.getElementById("boardEditorId").value || 0);
  const boardNumber = Number(document.getElementById("boardEditorNumber").value || 0);
  const name = document.getElementById("boardEditorName").value.trim();
  if (!id || boardNumber <= 0 || !name) return;
  const save = document.getElementById("boardEditorSave");
  const message = document.getElementById("boardEditorMessage");
  save.disabled = true;
  try {
    await requestJson(`${API_ROOT}/clubs/${clubId()}/kiosks/${id}`, { method: "PATCH", body: {
      board_number: boardNumber,
      name,
      sponsor_label: document.getElementById("boardEditorSponsor").value.trim(),
      sponsor_logo_url: document.getElementById("boardEditorSponsorLogo").value.trim(),
      scoring_mode: document.getElementById("boardEditorScoring").value,
      is_active: document.getElementById("boardEditorActive").checked ? 1 : 0,
    }});
    message.className = "board-editor-message good"; message.textContent = "Boardet er lagret.";
    setTimeout(() => { closeEditor(); refreshButton?.click(); }, 450);
  } catch (error) {
    message.className = "board-editor-message bad"; message.textContent = error.message;
  } finally { save.disabled = false; }
}

function decorateRows() {
  kioskList?.querySelectorAll(".board-row").forEach((row) => {
    if (row.querySelector(".board-edit-button")) return;
    const source = row.querySelector("[data-kiosk-id]");
    const id = Number(source?.dataset?.kioskId || 0);
    if (!id) return;
    const controls = row.querySelector(".board-controls") || row;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-edit-button";
    button.textContent = "Rediger";
    button.addEventListener("click", () => openEditor(id).catch((error) => window.alert(error.message)));
    controls.appendChild(button);
  });
}

ensureStyles();
ensureDialog();
const observer = new MutationObserver(decorateRows);
if (kioskList) observer.observe(kioskList, { childList: true, subtree: true });
decorateRows();

// Keep the UI explicit about ownership: boards belong to Blindleia Core.
const kioskIntro = document.querySelector("#kiosks .panel-head .muted");
if (kioskIntro) kioskIntro.textContent = "Boardene tilhører Blindleia Dartklubb. Nummer, navn, sponsor, scoring og nettbrett styres her med lokale board-ID-er.";
