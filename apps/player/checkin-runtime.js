const API_ROOT = "../api/v1";
const CHECKIN_STATUS_CACHE_MS = 5000;
const CHECKIN_REFRESH_MS = 15000;

const checkinStatusCache = new Map();
let gateRefreshTimer = null;
let gateMutationTimer = null;
let gateBusy = false;
let homeResolution = { key: "", tournamentId: 0, at: 0 };

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0); }
function statusArea() { return document.getElementById("statusArea"); }

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
}

function formatWindowTime(value) {
  const date = parseDate(value);
  if (!date) return "senere";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return `kl. ${new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
  }
  return `${new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit" }).format(date)} kl. ${new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function showStatus(message, tone = "info") {
  const root = statusArea();
  if (!root) { window.alert(message); return; }
  const card = document.createElement("div");
  card.className = "mini-card";
  const title = tone === "error" ? "Innsjekk feilet" : tone === "success" ? "Innsjekk OK" : "Innsjekk";
  card.innerHTML = `<strong>${title}</strong><p class="muted"></p>`;
  card.querySelector("p").textContent = message;
  root.prepend(card);
  while (root.children.length > 4) root.lastElementChild?.remove();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

async function getCheckinStatus(tournamentId, force = false) {
  const id = Number(tournamentId || 0);
  if (!id) return null;
  const cached = checkinStatusCache.get(id);
  if (!force && cached && Date.now() - cached.at < CHECKIN_STATUS_CACHE_MS) return cached.status;
  const status = await api(`/tournaments/${id}/check-in-status`);
  checkinStatusCache.set(id, { status, at: Date.now() });
  return status;
}

function ensureGateStyles() {
  if (document.getElementById("checkinWindowGateStyles")) return;
  const style = document.createElement("style");
  style.id = "checkinWindowGateStyles";
  style.textContent = `
    button.checkin-window-disabled:disabled,
    .player-now-actions button.checkin-window-disabled:disabled {
      background:#e7edf4!important;
      color:#718196!important;
      border-color:#d5dee8!important;
      box-shadow:none!important;
      opacity:1!important;
      cursor:not-allowed!important;
      filter:none!important;
    }
  `;
  document.head.appendChild(style);
}

function rememberButtonState(button) {
  if (!button.dataset.checkinWindowOriginalText) button.dataset.checkinWindowOriginalText = button.textContent?.trim() || "Innsjekk";
  if (button.dataset.checkinWindowInitialDisabled === undefined) button.dataset.checkinWindowInitialDisabled = button.disabled ? "1" : "0";
}

function setHomeHint(state, status) {
  const hint = document.getElementById("playerNowHint");
  if (!hint) return;
  if (!hint.dataset.checkinWindowOriginalText) hint.dataset.checkinWindowOriginalText = hint.textContent || "";
  if (state === "not_open") {
    hint.textContent = `Innsjekk åpner ${formatWindowTime(status?.opens_at)}. Du trenger ikke gjøre noe før det.`;
    return;
  }
  if (state === "closed") {
    hint.textContent = "Innsjekkvinduet er stengt. Kontakt turneringsleder dersom du trenger hjelp.";
    return;
  }
  hint.textContent = hint.dataset.checkinWindowOriginalText || "Neste steg er innsjekk.";
}

function applyWindowState(button, status) {
  if (!button || !status) return;
  rememberButtonState(button);
  const state = String(status.window_state || "");
  const isHome = button.matches("[data-px-checkin]");

  if (state === "not_open") {
    button.disabled = true;
    button.classList.add("checkin-window-disabled");
    button.dataset.checkinWindowDisabled = "1";
    button.textContent = `Innsjekk åpner ${formatWindowTime(status.opens_at)}`;
    button.title = `Innsjekk åpner ${formatWindowTime(status.opens_at)}`;
    button.setAttribute("aria-disabled", "true");
    if (isHome) setHomeHint("not_open", status);
    return;
  }

  if (state === "closed") {
    button.disabled = true;
    button.classList.add("checkin-window-disabled");
    button.dataset.checkinWindowDisabled = "1";
    button.textContent = "Innsjekk stengt";
    button.title = "Innsjekkvinduet er stengt";
    button.setAttribute("aria-disabled", "true");
    if (isHome) setHomeHint("closed", status);
    return;
  }

  if (button.dataset.checkinWindowDisabled === "1") {
    button.disabled = button.dataset.checkinWindowInitialDisabled === "1";
    delete button.dataset.checkinWindowDisabled;
  }
  button.classList.remove("checkin-window-disabled");
  button.textContent = button.dataset.checkinWindowOriginalText || button.textContent;
  button.removeAttribute("title");
  if (!button.disabled) button.removeAttribute("aria-disabled");
  if (isHome) setHomeHint("open", status);
}

function tournamentRelevant(tournament) {
  if (!tournament) return false;
  const status = String(tournament.status || tournament.tournament_status || "").toLowerCase();
  if (["completed", "cancelled", "canceled", "archived"].includes(status)) return false;
  const now = Date.now();
  const start = parseDate(tournament.start_at)?.getTime() ?? null;
  const end = parseDate(tournament.end_at)?.getTime() ?? null;
  if (end !== null && end < now) return false;
  if (start === null) return true;
  return start >= now - 18 * 60 * 60 * 1000;
}

async function resolveHomeTournamentId(button) {
  if (!button || !token()) return 0;
  const cid = clubId();
  const displayedName = normalize(document.querySelector("#playerNowBody .player-now-copy > strong")?.textContent || "");
  const key = `${token().slice(0, 12)}:${cid}:${displayedName}`;
  if (homeResolution.key === key && Date.now() - homeResolution.at < CHECKIN_REFRESH_MS) return homeResolution.tournamentId;

  const [dashboardData, tournamentData] = await Promise.all([
    api("/me/dashboard").catch(() => null),
    cid ? api(`/clubs/${cid}/registration-tournaments`).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
  ]);
  const registrations = Array.isArray(dashboardData?.dashboard?.registrations) ? dashboardData.dashboard.registrations : [];
  const tournaments = Array.isArray(tournamentData?.items) ? tournamentData.items : [];
  const byId = new Map(tournaments.map((item) => [Number(item.id), item]));

  let candidates = registrations
    .filter((registration) => String(registration.status || "") === "registered")
    .filter((registration) => !cid || !registration.club_id || Number(registration.club_id) === cid)
    .map((registration) => ({ registration, tournament: byId.get(Number(registration.tournament_id)) || registration }))
    .filter(({ tournament }) => tournamentRelevant(tournament));

  if (displayedName) {
    const matching = candidates.filter(({ tournament, registration }) => normalize(tournament.name || registration.tournament_name) === displayedName);
    if (matching.length) candidates = matching;
  }

  candidates.sort((a, b) => {
    const aStart = parseDate(a.tournament?.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bStart = parseDate(b.tournament?.start_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aStart - bStart;
  });

  const tournamentId = Number(candidates[0]?.registration?.tournament_id || candidates[0]?.tournament?.id || 0);
  homeResolution = { key, tournamentId, at: Date.now() };
  if (tournamentId) button.dataset.checkinWindowTournament = String(tournamentId);
  return tournamentId;
}

async function gateButton(button, tournamentId) {
  try {
    const status = await getCheckinStatus(tournamentId);
    applyWindowState(button, status);
    return status;
  } catch (error) {
    console.warn("Kunne ikke hente innsjekkvindu", error);
    return null;
  }
}

function scheduleGateRefresh(delay = CHECKIN_REFRESH_MS) {
  window.clearTimeout(gateRefreshTimer);
  gateRefreshTimer = window.setTimeout(() => refreshCheckinGates(true), Math.max(500, delay));
}

async function refreshCheckinGates(force = false) {
  if (gateBusy || !token()) {
    scheduleGateRefresh();
    return;
  }
  gateBusy = true;
  try {
    if (force) checkinStatusCache.clear();
    const work = [];
    document.querySelectorAll("button[data-checkin]").forEach((button) => {
      const tournamentId = Number(button.getAttribute("data-checkin") || 0);
      if (tournamentId) work.push(gateButton(button, tournamentId));
    });

    const homeButton = document.querySelector("button[data-px-checkin]");
    if (homeButton) {
      const tournamentId = Number(homeButton.dataset.checkinWindowTournament || 0) || await resolveHomeTournamentId(homeButton);
      if (tournamentId) work.push(gateButton(homeButton, tournamentId));
    }

    const statuses = (await Promise.all(work)).filter(Boolean);
    const openingTimes = statuses
      .filter((status) => String(status.window_state) === "not_open")
      .map((status) => parseDate(status.opens_at)?.getTime() ?? NaN)
      .filter(Number.isFinite)
      .filter((time) => time > Date.now());
    const nextOpening = openingTimes.length ? Math.min(...openingTimes) : null;
    const delay = nextOpening === null ? CHECKIN_REFRESH_MS : Math.min(CHECKIN_REFRESH_MS, Math.max(750, nextOpening - Date.now() + 400));
    scheduleGateRefresh(delay);
  } finally {
    gateBusy = false;
  }
}

function scheduleMutationRefresh() {
  window.clearTimeout(gateMutationTimer);
  gateMutationTimer = window.setTimeout(() => refreshCheckinGates(false), 120);
}

function ensureDialog() {
  if (document.getElementById("checkinCodeDialog")) return;
  const style = document.createElement("style");
  style.textContent = `.ci-dialog{border:1px solid rgba(255,255,255,.15);border-radius:18px;background:#101820;color:inherit;width:min(430px,calc(100% - 28px));padding:0;box-shadow:0 24px 80px rgba(0,0,0,.55)}.ci-dialog::backdrop{background:rgba(0,0,0,.72)}.ci-body{padding:20px;display:grid;gap:14px}.ci-body h3{margin:0}.ci-code{font-size:28px;letter-spacing:.18em;text-transform:uppercase;text-align:center;font-weight:800}.ci-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ci-message{min-height:20px}.ci-dialog button{min-height:44px}`;
  document.head.appendChild(style);
  const dialog = document.createElement("dialog");
  dialog.id = "checkinCodeDialog";
  dialog.className = "ci-dialog";
  dialog.innerHTML = `<form method="dialog" class="ci-body" id="checkinCodeForm"><div><p class="eyebrow">Turneringsinnsjekk</p><h3>Sjekk inn</h3></div><p id="ciHelp" class="muted"></p><input id="ciCode" class="ci-code" inputmode="text" autocomplete="one-time-code" maxlength="12" placeholder="KODE"><div id="ciMessage" class="muted ci-message"></div><div class="ci-actions"><button id="ciCancel" type="button" class="ghost">Avbryt</button><button id="ciSubmit" type="submit">Sjekk inn</button></div></form>`;
  document.body.appendChild(dialog);
  document.getElementById("ciCancel").addEventListener("click", () => dialog.close());
}

let activeTournamentId = 0;
let activeStatus = null;

async function openCheckin(tournamentId) {
  if (!token()) throw new Error("Logg inn før du sjekker inn.");
  ensureDialog();
  const dialog = document.getElementById("checkinCodeDialog");
  const status = await getCheckinStatus(tournamentId, true);
  activeTournamentId = tournamentId;
  activeStatus = status;

  if (status.registration_status === "checked_in") { showStatus("Du er allerede sjekket inn.", "success"); return; }
  if (status.window_state === "not_open") throw new Error(`Innsjekk er ikke åpnet ennå. Den åpner ${formatWindowTime(status.opens_at)}.`);
  if (status.window_state === "closed") throw new Error("Innsjekk er stengt. Kontakt turneringsleder.");
  if (status.method === "admin_only") { showStatus("Denne turneringen sjekkes inn av turneringsleder. Gå til innsjekkbordet."); return; }

  const codeInput = document.getElementById("ciCode");
  document.getElementById("ciMessage").textContent = "";
  codeInput.value = "";
  document.getElementById("ciHelp").textContent = "Tast koden som vises på Live-skjermen i lokalet. Turneringsleder kan også sjekke deg inn fra admin.";
  dialog.showModal();
  window.setTimeout(() => codeInput.focus(), 50);
}

async function submitCode(event) {
  event.preventDefault();
  if (!activeTournamentId || !activeStatus?.code_allowed) return;
  const code = document.getElementById("ciCode").value.trim();
  if (!code) { document.getElementById("ciMessage").textContent = "Tast inn koden fra Live-skjermen."; return; }
  const button = document.getElementById("ciSubmit");
  button.disabled = true;
  try {
    await api(`/tournaments/${activeTournamentId}/check-in`, { method: "POST", body: { code } });
    checkinStatusCache.delete(activeTournamentId);
    document.getElementById("checkinCodeDialog").close();
    showStatus("Du er sjekket inn og klar for turneringen.", "success");
    window.dispatchEvent(new CustomEvent("bd:player-state-changed"));
    window.setTimeout(() => window.location.reload(), 500);
  } catch (error) {
    document.getElementById("ciMessage").textContent = error.message;
  } finally { button.disabled = false; }
}

ensureGateStyles();
ensureDialog();
document.getElementById("checkinCodeForm")?.addEventListener("submit", submitCode);

// Capture phase owns existing check-in buttons before the older app.js click handler.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-checkin]") : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const tournamentId = Number(target.getAttribute("data-checkin") || 0);
  if (!tournamentId) return;
  openCheckin(tournamentId).catch((error) => showStatus(error.message, "error"));
}, true);

const gateObserver = new MutationObserver(scheduleMutationRefresh);
gateObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener("bd:player-state-changed", () => {
  homeResolution = { key: "", tournamentId: 0, at: 0 };
  refreshCheckinGates(true);
});
window.addEventListener("storage", (event) => {
  if (["bd:token", "bd:playerClubId"].includes(event.key || "")) {
    homeResolution = { key: "", tournamentId: 0, at: 0 };
    refreshCheckinGates(true);
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCheckinGates(true);
});

window.BlindleiaCheckinWindow = Object.freeze({
  getStatus: (tournamentId) => getCheckinStatus(tournamentId, true),
  formatOpen: formatWindowTime,
  refresh: () => refreshCheckinGates(true),
});

window.setTimeout(() => refreshCheckinGates(true), 250);
