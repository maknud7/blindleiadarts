const API_ROOT = "../api/v1";

const clubSelect = document.getElementById("clubSelect");
const refreshAll = document.getElementById("refreshAllButton");
let dashboard = null;
let loading = false;
let pollTimer = null;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function bool(value) { return Number(value || 0) === 1; }

async function request(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureStyles() {
  if (document.getElementById("scoliaAdminStyles")) return;
  const style = document.createElement("style");
  style.id = "scoliaAdminStyles";
  style.textContent = `
    .integration-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.integration-card{border:1px solid var(--line);border-radius:16px;padding:16px;background:rgba(255,255,255,.02);display:grid;gap:12px}.integration-card h3{margin:0}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.settings-grid .wide{grid-column:1/-1}.settings-grid label{display:grid;gap:6px;color:var(--muted);font-size:13px}.check-row{display:flex!important;align-items:center;gap:8px!important}.check-row input{width:auto!important}.integration-actions{display:flex;gap:8px;flex-wrap:wrap}.integration-status{padding:10px 12px;border:1px solid var(--line);border-radius:10px}.integration-status.good{border-color:rgba(77,212,166,.45)}.integration-status.bad{border-color:rgba(255,107,107,.45)}.scolia-board-list{display:grid;gap:10px}.scolia-board{border:1px solid var(--line);border-radius:13px;padding:12px;display:grid;gap:10px}.scolia-board-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.scolia-board-fields{display:grid;grid-template-columns:1.3fr .8fr auto;gap:8px;align-items:end}.scolia-runtime-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px}.queue-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}.queue-chip{border:1px solid var(--line);border-radius:10px;padding:9px;text-align:center}.queue-chip strong{display:block;font-size:20px}.incident-list{display:grid;gap:8px}.incident{border:1px solid var(--line);border-radius:11px;padding:11px;display:grid;grid-template-columns:1fr auto;gap:10px}.incident.critical,.incident.error{border-color:rgba(255,107,107,.45)}.incident.warning{border-color:rgba(255,194,92,.35)}.failed-event{font-size:12px}@media(max-width:900px){.integration-grid{grid-template-columns:1fr}.queue-grid{grid-template-columns:repeat(3,1fr)}.scolia-board-fields{grid-template-columns:1fr}.settings-grid{grid-template-columns:1fr}.settings-grid .wide{grid-column:auto}}`;
  document.head.appendChild(style);
}

function ensurePanel() {
  if (document.getElementById("integrations")) return;
  ensureStyles();
  const nav = document.querySelector(".section-nav");
  if (nav && !nav.querySelector('a[href="#integrations"]')) {
    const link = document.createElement("a");
    link.href = "#integrations";
    link.dataset.portalNav = "1";
    link.textContent = "Scolia / innstillinger";
    nav.appendChild(link);
  }

  const panel = document.createElement("section");
  panel.id = "integrations";
  panel.dataset.portalSection = "integrations";
  panel.className = "panel";
  panel.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">Integrasjoner og drift</p><h2>Scolia / innstillinger</h2><p class="muted">Scolia er en valgfri scorekilde. Blindleia beholder canonical kampstate. Her ser du kø, feil, fallback og klubbens check-in-standard.</p></div><button id="scoliaRefresh" type="button" class="button secondary">Oppdater status</button></div>
    <div id="scoliaAdminMessage" class="integration-status hidden"></div>
    <div class="integration-grid">
      <form id="scoliaGeneralForm" class="integration-card">
        <div><p class="eyebrow">Generelt for klubben</p><h3>Scolia-konto og drift</h3></div>
        <div class="settings-grid">
          <label class="check-row wide"><input id="scoliaEnabled" type="checkbox"><span>Aktiver Scolia Bridge for klubben</span></label>
          <label class="wide"><span>Service Account access token</span><input id="scoliaToken" type="password" autocomplete="new-password" placeholder="Ikke endre lagret token"></label>
          <label class="check-row"><input id="scoliaForce" type="checkbox"><span>forceConnect ved tilkobling</span></label>
          <label class="check-row"><input id="scoliaForward" type="checkbox"><span>Forward eventer til Scolia-appen</span></label>
          <label class="check-row wide"><input id="scoliaFallback" type="checkbox"><span>Automatisk manuell fallback ved disconnect under kamp</span></label>
          <label><span>Maks retry</span><input id="scoliaAttempts" type="number" min="1" max="20"></label>
          <label><span>Retry base (sek)</span><input id="scoliaRetryBase" type="number" min="1" max="300"></label>
          <label><span>Behold råeventer (dager)</span><input id="scoliaRetention" type="number" min="1" max="365"></label>
        </div>
        <div class="integration-actions"><button type="submit" class="button">Lagre Scolia-oppsett</button><button id="scoliaDrain" type="button" class="button secondary">Kjør kø nå</button></div>
        <p id="scoliaTokenHint" class="muted"></p>
      </form>

      <form id="checkinGeneralForm" class="integration-card">
        <div><p class="eyebrow">Generelt for klubben</p><h3>Check-in-standard</h3></div>
        <p class="muted">Laster check-in-oppsett …</p>
      </form>
    </div>

    <div class="subsection-head" style="margin-top:20px"><div><h3>Scolia per skive</h3><p class="muted">Serialnummer og off/shadow/live settes per canonical board. Shadow leser Scolia uten å skrive score.</p></div></div>
    <div id="scoliaBoardList" class="scolia-board-list"></div>

    <div class="integration-grid" style="margin-top:20px">
      <div class="integration-card"><div><p class="eyebrow">Durable eventkø</p><h3>Køstatus</h3></div><div id="scoliaQueue" class="queue-grid"></div><p class="muted">Failed prøves automatisk på nytt med exponential backoff. Dead-letter krever manuell handling.</p></div>
      <div class="integration-card"><div><p class="eyebrow">Driftsavvik</p><h3>Åpne Scolia-feil</h3></div><div id="scoliaIncidents" class="incident-list"></div></div>
    </div>
    <div class="integration-card" style="margin-top:18px"><div><p class="eyebrow">Dead-letter / siste feil</p><h3>Eventer som trenger hjelp</h3></div><div id="scoliaFailedEvents" class="incident-list"></div></div>`;

  document.querySelector("main.main")?.appendChild(panel);
  bindPanel();
}

function message(text, tone = "good") {
  const root = document.getElementById("scoliaAdminMessage");
  if (!root) return;
  root.textContent = text;
  root.className = `integration-status ${tone}`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" }).format(d);
}

function renderGeneral() {
  const settings = dashboard?.settings || {};
  document.getElementById("scoliaEnabled").checked = bool(settings.enabled);
  document.getElementById("scoliaForce").checked = bool(settings.force_connect);
  document.getElementById("scoliaForward").checked = bool(settings.forward_messages_to_scolia);
  document.getElementById("scoliaFallback").checked = bool(settings.disconnect_fallback_enabled);
  document.getElementById("scoliaAttempts").value = Number(settings.queue_max_attempts || 8);
  document.getElementById("scoliaRetryBase").value = Number(settings.queue_retry_base_seconds || 2);
  document.getElementById("scoliaRetention").value = Number(settings.event_retention_days || 30);
  document.getElementById("scoliaToken").value = "";
  document.getElementById("scoliaToken").placeholder = settings.access_token_configured ? "Lagret token – skriv bare for å bytte" : "Lim inn Scolia Service Account token";
  document.getElementById("scoliaTokenHint").textContent = settings.access_token_configured ? `Token er lagret (${settings.access_token_masked || "maskert"}). Verdien vises aldri tilbake i admin.` : "Ingen Scolia access token er lagret ennå.";
}

function runtimeBadge(board) {
  if (Number(board.needs_reconciliation) === 1) return `<span class="badge bad">Må avstemmes</span>`;
  if (Number(board.fallback_active) === 1) return `<span class="badge warning">Manuell fallback</span>`;
  if (board.mode === "off" || !board.serial_number) return `<span class="badge neutral">Scolia av</span>`;
  if (board.connection_state === "connected") return `<span class="badge good">Tilkoblet</span>`;
  if (board.connection_state === "error") return `<span class="badge bad">Feil</span>`;
  return `<span class="badge warning">${esc(board.connection_state || "frakoblet")}</span>`;
}

function renderBoards() {
  const root = document.getElementById("scoliaBoardList");
  const boards = dashboard?.boards || [];
  if (!boards.length) {
    root.innerHTML = `<div class="empty">Ingen boards finnes.</div>`;
    return;
  }
  root.innerHTML = boards.map((board) => `
    <article class="scolia-board" data-scolia-board="${Number(board.id)}">
      <div class="scolia-board-head"><div><strong>Board ${Number(board.board_number)} · ${esc(board.name)}</strong><div class="scolia-runtime-meta"><span>${esc(board.code)}</span><span>Sist event: ${esc(formatDate(board.last_event_at))}</span><span>Bridge: ${esc(formatDate(board.last_bridge_heartbeat_at))}</span></div></div>${runtimeBadge(board)}</div>
      <div class="scolia-board-fields">
        <label><span>Serialnummer</span><input data-field="serial" value="${esc(board.serial_number || "")}" placeholder="Scolia serial number"></label>
        <label><span>Modus</span><select data-field="mode"><option value="off" ${board.mode === "off" || !board.mode ? "selected" : ""}>Off</option><option value="shadow" ${board.mode === "shadow" ? "selected" : ""}>Shadow</option><option value="live" ${board.mode === "live" ? "selected" : ""}>Live</option></select></label>
        <label class="check-row"><input data-field="fallback" type="checkbox" ${Number(board.auto_fallback_to_manual ?? 1) === 1 ? "checked" : ""}><span>Auto fallback</span></label>
      </div>
      <div class="integration-actions"><button type="button" class="button" data-board-action="save">Lagre skive</button>${board.mode === "live" ? `<button type="button" class="button secondary" data-board-action="fallback">Manuell fallback</button><button type="button" class="button secondary" data-board-action="reset">Reset fase</button>` : ""}${Number(board.fallback_active) === 1 || Number(board.needs_reconciliation) === 1 ? `<button type="button" class="button" data-board-action="resume" ${board.connection_state === "connected" ? "" : "disabled"}>Avstemt – gjenoppta Scolia</button>` : ""}</div>
      ${board.last_disconnect_reason ? `<p class="muted">Siste disconnect: ${esc(board.last_disconnect_reason)}</p>` : ""}
    </article>`).join("");
  root.querySelectorAll("[data-board-action]").forEach((button) => button.addEventListener("click", () => boardAction(button).catch((error) => message(error.message, "bad"))));
}

function renderQueue() {
  const q = dashboard?.queue || {};
  document.getElementById("scoliaQueue").innerHTML = ["queued","processing","failed","dead_letter","processed","ignored"].map((key) => `<div class="queue-chip"><strong>${Number(q[key] || 0)}</strong><span>${esc(key)}</span></div>`).join("");
}

function renderIncidents() {
  const root = document.getElementById("scoliaIncidents");
  const items = dashboard?.incidents || [];
  root.innerHTML = items.length ? items.map((item) => `<div class="incident ${esc(item.severity)}"><div><strong>${esc(item.summary)}</strong><p class="muted">${item.board_number ? `Board ${Number(item.board_number)} · ` : ""}${esc(item.category)} · ${esc(formatDate(item.last_seen_at))} · ${Number(item.occurrence_count || 1)}x</p>${item.details ? `<p class="muted">${esc(item.details)}</p>` : ""}</div><button type="button" class="button secondary" data-resolve-incident="${Number(item.id)}">Løst</button></div>`).join("") : `<p class="muted">Ingen åpne Scolia-avvik.</p>`;
  root.querySelectorAll("[data-resolve-incident]").forEach((button) => button.addEventListener("click", async () => {
    await request(`/clubs/${clubId()}/scolia/incidents/${Number(button.dataset.resolveIncident)}/resolve`, { method: "POST" });
    await load();
  }));
}

function renderFailed() {
  const root = document.getElementById("scoliaFailedEvents");
  const items = dashboard?.failed_events || [];
  root.innerHTML = items.length ? items.map((item) => `<div class="incident ${item.processing_status === "dead_letter" ? "critical" : "warning"}"><div><strong>#${Number(item.id)} · ${esc(item.event_type)} · Board ${Number(item.board_number)}</strong><p class="muted failed-event">${esc(item.processing_status)} · forsøk ${Number(item.attempt_count)} · ${esc(formatDate(item.received_at))}</p><p class="muted failed-event">${esc(item.last_error || "")}</p></div>${item.processing_status === "dead_letter" ? `<button type="button" class="button" data-retry-event="${Number(item.id)}">Prøv igjen</button>` : ""}</div>`).join("") : `<p class="muted">Ingen failed/dead-letter-eventer.</p>`;
  root.querySelectorAll("[data-retry-event]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await request(`/clubs/${clubId()}/scolia/events/${Number(button.dataset.retryEvent)}/retry`, { method: "POST" }); await load(); } finally { button.disabled = false; }
  }));
}

function renderAll() {
  renderGeneral();
  renderBoards();
  renderQueue();
  renderIncidents();
  renderFailed();
}

async function load() {
  if (loading || !clubId() || !token()) return;
  loading = true;
  try {
    dashboard = await request(`/clubs/${clubId()}/scolia`);
    renderAll();
  } catch (error) {
    message(error.message, "bad");
  } finally {
    loading = false;
  }
}

async function saveScolia(event) {
  event.preventDefault();
  const body = {
    enabled: document.getElementById("scoliaEnabled").checked,
    force_connect: document.getElementById("scoliaForce").checked,
    forward_messages_to_scolia: document.getElementById("scoliaForward").checked,
    disconnect_fallback_enabled: document.getElementById("scoliaFallback").checked,
    queue_max_attempts: Number(document.getElementById("scoliaAttempts").value || 8),
    queue_retry_base_seconds: Number(document.getElementById("scoliaRetryBase").value || 2),
    event_retention_days: Number(document.getElementById("scoliaRetention").value || 30),
  };
  const accessToken = document.getElementById("scoliaToken").value.trim();
  if (accessToken) body.access_token = accessToken;
  await request(`/clubs/${clubId()}/scolia/settings`, { method: "PATCH", body });
  message("Scolia-oppsettet er lagret.");
  await load();
}

async function boardAction(button) {
  const row = button.closest("[data-scolia-board]");
  const kioskId = Number(row?.dataset.scoliaBoard || 0);
  const action = button.dataset.boardAction;
  if (!kioskId) return;
  button.disabled = true;
  try {
    if (action === "save") {
      await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia`, { method: "PATCH", body: {
        serial_number: row.querySelector('[data-field="serial"]').value.trim(),
        mode: row.querySelector('[data-field="mode"]').value,
        auto_fallback_to_manual: row.querySelector('[data-field="fallback"]').checked,
      }});
      message("Scolia-oppsettet for boardet er lagret.");
    } else if (action === "fallback") {
      if (!window.confirm("Aktivere manuell fallback? Canonical score fortsetter på nettbrettet, og Scolia ignoreres til score er avstemt.")) return;
      await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia/fallback`, { method: "POST" });
    } else if (action === "resume") {
      if (!window.confirm("Bekrefter du at canonical score er kontrollert og riktig?")) return;
      await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia/resume`, { method: "POST" });
    } else if (action === "reset") {
      if (!window.confirm("Reset Scolia-fasen? Uferdig Scolia-buffer tømmes, men canonical score endres ikke.")) return;
      await request(`/clubs/${clubId()}/kiosks/${kioskId}/scolia/reset-phase`, { method: "POST" });
    }
    await load();
  } finally {
    button.disabled = false;
  }
}

function bindPanel() {
  document.getElementById("scoliaGeneralForm")?.addEventListener("submit", (event) => saveScolia(event).catch((error) => message(error.message, "bad")));
  document.getElementById("scoliaRefresh")?.addEventListener("click", () => load());
  document.getElementById("scoliaDrain")?.addEventListener("click", async () => {
    await request(`/clubs/${clubId()}/scolia/queue/drain`, { method: "POST" });
    await load();
  });
}

ensurePanel();
clubSelect?.addEventListener("change", () => window.setTimeout(() => load(), 150));
refreshAll?.addEventListener("click", () => window.setTimeout(() => load(), 150));
load();
pollTimer = window.setInterval(() => {
  if (!document.hidden && location.hash === "#integrations") load();
}, 5000);
window.addEventListener("beforeunload", () => clearInterval(pollTimer));
