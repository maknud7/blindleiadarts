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
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function ensureStyles() {
  if (document.getElementById("scoliaAdminStyles")) return;
  const style = document.createElement("style");
  style.id = "scoliaAdminStyles";
  style.textContent = `
    .scolia-equipment{margin-top:22px;border-top:1px solid var(--line);padding-top:22px}
    .scolia-equipment-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}
    .scolia-equipment-head h3{margin:2px 0 4px}
    .integration-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}
    .integration-card{border:1px solid var(--line);border-radius:16px;padding:16px;background:rgba(255,255,255,.02);display:grid;gap:12px}
    .integration-card h4{margin:0}
    .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .settings-grid .wide{grid-column:1/-1}
    .settings-grid label{display:grid;gap:6px;color:var(--muted);font-size:13px}
    .check-row{display:flex!important;align-items:center;gap:8px!important}
    .check-row input{width:auto!important}
    .integration-actions{display:flex;gap:8px;flex-wrap:wrap}
    .integration-status{padding:10px 12px;border:1px solid var(--line);border-radius:10px}
    .integration-status.good{border-color:rgba(77,212,166,.45)}
    .integration-status.bad{border-color:rgba(255,107,107,.45)}
    .queue-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
    .queue-chip{border:1px solid var(--line);border-radius:10px;padding:9px;text-align:center}
    .queue-chip strong{display:block;font-size:20px}
    .incident-list{display:grid;gap:8px}
    .incident{border:1px solid var(--line);border-radius:11px;padding:11px;display:grid;grid-template-columns:1fr auto;gap:10px}
    .incident.critical,.incident.error{border-color:rgba(255,107,107,.45)}
    .incident.warning{border-color:rgba(255,194,92,.35)}
    .failed-event{font-size:12px}
    .scolia-advanced{margin-top:2px}
    .scolia-advanced summary{cursor:pointer;font-weight:600}
    .scolia-advanced .integration-grid{margin-top:14px}
    @media(max-width:900px){.scolia-equipment-head{display:grid}.integration-grid{grid-template-columns:1fr}.queue-grid{grid-template-columns:repeat(3,1fr)}.settings-grid{grid-template-columns:1fr}.settings-grid .wide{grid-column:auto}}
  `;
  document.head.appendChild(style);
}

function ensurePanel() {
  if (document.getElementById("scoliaEquipmentPanel")) return;
  const equipment = document.getElementById("kiosks");
  if (!equipment) return;

  ensureStyles();
  const panel = document.createElement("section");
  panel.id = "scoliaEquipmentPanel";
  panel.className = "scolia-equipment";
  panel.innerHTML = `
    <div class="scolia-equipment-head">
      <div>
        <p class="eyebrow">Automatisk scoring</p>
        <h3>Scolia</h3>
        <p class="muted">Én klubbkonto kan brukes mot flere Scolia-skiver. Serienummer og scoringstype settes på hver enkelt skive over.</p>
      </div>
      <button id="scoliaRefresh" type="button" class="button secondary">Oppdater status</button>
    </div>

    <div id="scoliaAdminMessage" class="integration-status hidden"></div>

    <div class="integration-grid">
      <form id="scoliaGeneralForm" class="integration-card">
        <div><p class="eyebrow">Klubbkonto</p><h4>Scolia Service Account</h4></div>
        <p class="muted">Denne tilkoblingen gjelder klubben. Hver Scolia-enhet kobles deretter til riktig skive med sitt eget serienummer.</p>
        <div class="settings-grid">
          <label class="check-row wide"><input id="scoliaEnabled" type="checkbox"><span>Aktiver Scolia for klubben</span></label>
          <label class="wide"><span>Service Account access token</span><input id="scoliaToken" type="password" autocomplete="new-password" placeholder="Ikke endre lagret token"></label>
        </div>
        <div class="integration-actions"><button type="submit" class="button">Lagre Scolia-oppsett</button></div>
        <p id="scoliaTokenHint" class="muted"></p>
      </form>

      <div class="integration-card">
        <div><p class="eyebrow">Skiver</p><h4>Flere Scolia-enheter</h4></div>
        <p class="muted">Opprett eller rediger hver skive separat og velg <strong>Scolia</strong> som scoring. Legg inn serienummeret til den fysiske Scolia-enheten på den aktuelle skiva.</p>
        <div class="integration-status good"><strong>Klar for flere skiver</strong><br><span class="muted">Service Account er klubbnivå. Serienummeret er skivenivå, slik at Skive 1, Skive 2 osv. kan ha hver sin Scolia.</span></div>
      </div>
    </div>

    <details class="scolia-advanced">
      <summary>Avansert drift og feilsøking</summary>
      <div class="integration-grid">
        <form id="scoliaAdvancedForm" class="integration-card">
          <div><p class="eyebrow">Bridge</p><h4>Tekniske innstillinger</h4></div>
          <div class="settings-grid">
            <label class="check-row"><input id="scoliaForce" type="checkbox"><span>forceConnect ved tilkobling</span></label>
            <label class="check-row"><input id="scoliaForward" type="checkbox"><span>Forward eventer til Scolia-appen</span></label>
            <label class="check-row wide"><input id="scoliaFallback" type="checkbox"><span>Automatisk manuell fallback ved disconnect under kamp</span></label>
            <label><span>Maks retry</span><input id="scoliaAttempts" type="number" min="1" max="20"></label>
            <label><span>Retry base (sek)</span><input id="scoliaRetryBase" type="number" min="1" max="300"></label>
            <label><span>Behold råeventer (dager)</span><input id="scoliaRetention" type="number" min="1" max="365"></label>
          </div>
          <div class="integration-actions"><button type="submit" class="button secondary">Lagre avansert</button><button id="scoliaDrain" type="button" class="button secondary">Kjør kø nå</button></div>
        </form>

        <div class="integration-card"><div><p class="eyebrow">Durable eventkø</p><h4>Køstatus</h4></div><div id="scoliaQueue" class="queue-grid"></div><p class="muted">Failed prøves automatisk på nytt. Dead-letter krever manuell handling.</p></div>
      </div>

      <div class="integration-grid" style="margin-top:18px">
        <div class="integration-card"><div><p class="eyebrow">Driftsavvik</p><h4>Åpne Scolia-feil</h4></div><div id="scoliaIncidents" class="incident-list"></div></div>
        <div class="integration-card"><div><p class="eyebrow">Dead-letter / siste feil</p><h4>Eventer som trenger hjelp</h4></div><div id="scoliaFailedEvents" class="incident-list"></div></div>
      </div>
    </details>`;

  equipment.appendChild(panel);
  bindPanel();
}

function message(text, tone = "good") {
  const el = document.getElementById("scoliaAdminMessage");
  if (!el) return;
  el.textContent = text;
  el.className = `integration-status ${tone}`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" }).format(d);
}

function renderGeneral() {
  const settings = dashboard?.settings || {};
  const enabled = document.getElementById("scoliaEnabled");
  if (!enabled) return;
  enabled.checked = bool(settings.enabled);
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

function renderQueue() {
  const root = document.getElementById("scoliaQueue");
  if (!root) return;
  const q = dashboard?.queue || {};
  root.innerHTML = ["queued","processing","failed","dead_letter","processed","ignored"].map((key) => `<div class="queue-chip"><strong>${Number(q[key] || 0)}</strong><span>${esc(key)}</span></div>`).join("");
}

function renderIncidents() {
  const root = document.getElementById("scoliaIncidents");
  if (!root) return;
  const items = dashboard?.incidents || [];
  root.innerHTML = items.length ? items.map((item) => `<div class="incident ${esc(item.severity)}"><div><strong>${esc(item.summary)}</strong><p class="muted">${item.board_number ? `Skive ${Number(item.board_number)} · ` : ""}${esc(item.category)} · ${esc(formatDate(item.last_seen_at))} · ${Number(item.occurrence_count || 1)}x</p>${item.details ? `<p class="muted">${esc(item.details)}</p>` : ""}</div><button type="button" class="button secondary" data-resolve-incident="${Number(item.id)}">Løst</button></div>`).join("") : `<p class="muted">Ingen åpne Scolia-avvik.</p>`;
  root.querySelectorAll("[data-resolve-incident]").forEach((button) => button.addEventListener("click", async () => {
    await request(`/clubs/${clubId()}/scolia/incidents/${Number(button.dataset.resolveIncident)}/resolve`, { method: "POST" });
    await load();
  }));
}

function renderFailed() {
  const root = document.getElementById("scoliaFailedEvents");
  if (!root) return;
  const items = dashboard?.failed_events || [];
  root.innerHTML = items.length ? items.map((item) => `<div class="incident ${item.processing_status === "dead_letter" ? "critical" : "warning"}"><div><strong>#${Number(item.id)} · ${esc(item.event_type)} · Skive ${Number(item.board_number)}</strong><p class="muted failed-event">${esc(item.processing_status)} · forsøk ${Number(item.attempt_count)} · ${esc(formatDate(item.received_at))}</p><p class="muted failed-event">${esc(item.last_error || "")}</p></div>${item.processing_status === "dead_letter" ? `<button type="button" class="button" data-retry-event="${Number(item.id)}">Prøv igjen</button>` : ""}</div>`).join("") : `<p class="muted">Ingen failed/dead-letter-eventer.</p>`;
  root.querySelectorAll("[data-retry-event]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await request(`/clubs/${clubId()}/scolia/events/${Number(button.dataset.retryEvent)}/retry`, { method: "POST" }); await load(); } finally { button.disabled = false; }
  }));
}

async function load() {
  ensurePanel();
  if (loading || !clubId() || !token() || !document.getElementById("scoliaEquipmentPanel")) return;
  loading = true;
  try {
    dashboard = await request(`/clubs/${clubId()}/scolia`);
    renderGeneral();
    renderQueue();
    renderIncidents();
    renderFailed();
  } catch (error) { message(error.message, "bad"); }
  finally { loading = false; }
}

function settingsBody({ includeGeneral = true, includeAdvanced = true } = {}) {
  const body = {};
  if (includeGeneral) body.enabled = document.getElementById("scoliaEnabled").checked;
  if (includeAdvanced) {
    body.force_connect = document.getElementById("scoliaForce").checked;
    body.forward_messages_to_scolia = document.getElementById("scoliaForward").checked;
    body.disconnect_fallback_enabled = document.getElementById("scoliaFallback").checked;
    body.queue_max_attempts = Number(document.getElementById("scoliaAttempts").value || 8);
    body.queue_retry_base_seconds = Number(document.getElementById("scoliaRetryBase").value || 2);
    body.event_retention_days = Number(document.getElementById("scoliaRetention").value || 30);
  }
  return body;
}

async function saveGeneral(event) {
  event.preventDefault();
  const body = settingsBody({ includeGeneral: true, includeAdvanced: false });
  const accessToken = document.getElementById("scoliaToken").value.trim();
  if (accessToken) body.access_token = accessToken;
  await request(`/clubs/${clubId()}/scolia/settings`, { method: "PATCH", body });
  message("Scolia-oppsettet er lagret.");
  await load();
}

async function saveAdvanced(event) {
  event.preventDefault();
  const body = settingsBody({ includeGeneral: false, includeAdvanced: true });
  await request(`/clubs/${clubId()}/scolia/settings`, { method: "PATCH", body });
  message("Avanserte Scolia-innstillinger er lagret.");
  await load();
}

function bindPanel() {
  document.getElementById("scoliaGeneralForm")?.addEventListener("submit", (event) => saveGeneral(event).catch((error) => message(error.message, "bad")));
  document.getElementById("scoliaAdvancedForm")?.addEventListener("submit", (event) => saveAdvanced(event).catch((error) => message(error.message, "bad")));
  document.getElementById("scoliaRefresh")?.addEventListener("click", () => load());
  document.getElementById("scoliaDrain")?.addEventListener("click", async () => { await request(`/clubs/${clubId()}/scolia/queue/drain`, { method: "POST" }); await load(); });
}

ensurePanel();
clubSelect?.addEventListener("change", () => window.setTimeout(() => load(), 150));
refreshAll?.addEventListener("click", () => window.setTimeout(() => load(), 150));
load();
pollTimer = window.setInterval(() => { if (!document.hidden && (location.hash === "#kiosks" || location.hash === "#equipment")) load(); }, 5000);
window.addEventListener("beforeunload", () => clearInterval(pollTimer));
