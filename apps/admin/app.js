const API_ROOT = "../api/v1";
const DARTSATLAS_ADMIN_URL = "../api/dartsatlas-admin.php";
const DARTSATLAS_LIVE_URL = "../api/dartsatlas-live.php";

const state = {
  token: localStorage.getItem("bd:token") || "",
  me: null,
  clubs: [],
  clubId: Number(localStorage.getItem("bd:selectedClubId") || 0),
  admin: null,
  live: null,
  kiosks: [],
  pairingRequests: [],
  adminEndpointAvailable: true,
  loading: false,
};

const el = {
  authGate: document.getElementById("authGate"), adminApp: document.getElementById("adminApp"),
  loginForm: document.getElementById("loginForm"), loginUsername: document.getElementById("loginUsername"), loginPassword: document.getElementById("loginPassword"), loginMessage: document.getElementById("loginMessage"),
  logoutButton: document.getElementById("logoutButton"), refreshAllButton: document.getElementById("refreshAllButton"), refreshDartsAtlasButton: document.getElementById("refreshDartsAtlasButton"),
  clubSelect: document.getElementById("clubSelect"), clubName: document.getElementById("clubName"), globalMessage: document.getElementById("globalMessage"), metrics: document.getElementById("metrics"),
  dartsAtlasStatus: document.getElementById("dartsAtlasStatus"), seasonLabel: document.getElementById("seasonLabel"), tournamentList: document.getElementById("tournamentList"),
  memberRegistryStatus: document.getElementById("memberRegistryStatus"), playerRows: document.getElementById("playerRows"), unlinkedOnly: document.getElementById("unlinkedOnly"),
  screenForm: document.getElementById("screenForm"), screenList: document.getElementById("screenList"), screenCount: document.getElementById("screenCount"),
  kioskClubCode: document.getElementById("kioskClubCode"), copyKioskClubCode: document.getElementById("copyKioskClubCode"), kioskForm: document.getElementById("kioskForm"),
  kioskList: document.getElementById("kioskList"), kioskCount: document.getElementById("kioskCount"), pairingRequestList: document.getElementById("pairingRequestList"), pairingCount: document.getElementById("pairingCount"),
};

function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function persistToken(token) { state.token = token || ""; state.token ? localStorage.setItem("bd:token", state.token) : localStorage.removeItem("bd:token"); }
function showMessage(target, message, tone = "info") { target.textContent = message; target.className = `message ${tone}`; }
function hideMessage(target) { target.textContent = ""; target.className = "message hidden"; }

async function requestJson(url, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status; error.payload = payload; throw error;
  }
  return payload.data;
}
function api(path, options = {}) { return requestJson(`${API_ROOT}${path}`, options); }
async function dartsAdmin({ action = "", method = "GET", body } = {}) {
  const url = new URL(DARTSATLAS_ADMIN_URL, window.location.href); url.searchParams.set("club_id", String(state.clubId)); if (action) url.searchParams.set("action", action);
  return requestJson(url, { method, body, auth: true });
}

async function loadMe() {
  if (!state.token) return false;
  try {
    const data = await api("/auth/me", { auth: true }); state.me = data.user;
    if (!["club_admin", "super_admin"].includes(state.me?.role || "")) throw new Error("Denne kontoen har ikke administratortilgang.");
    return true;
  } catch (error) { persistToken(""); state.me = null; showMessage(el.loginMessage, error.message, "error"); return false; }
}
async function loadClubs() {
  const data = await api("/clubs"); let clubs = data.items || [];
  if (state.me?.role === "club_admin" && state.me?.player?.club_id) clubs = clubs.filter((club) => Number(club.id) === Number(state.me.player.club_id));
  state.clubs = clubs;
  if (!state.clubs.some((club) => Number(club.id) === state.clubId)) state.clubId = Number(state.clubs[0]?.id || 0);
  localStorage.setItem("bd:selectedClubId", String(state.clubId || "")); renderClubSelect();
}
function renderClubSelect() {
  el.clubSelect.innerHTML = state.clubs.map((club) => `<option value="${Number(club.id)}">${escapeHtml(club.name)}</option>`).join("");
  el.clubSelect.value = String(state.clubId || ""); el.clubSelect.classList.toggle("hidden", state.clubs.length <= 1);
}
async function loadLive() {
  try { state.live = await requestJson(new URL(DARTSATLAS_LIVE_URL, window.location.href)); }
  catch (error) { state.live = { tournament: null, feed: { status: "utilgjengelig", error: error.message } }; }
}
async function loadAdminFallback() {
  const [playersData, tournamentsData, screensData] = await Promise.all([
    api(`/clubs/${state.clubId}/players`), api(`/clubs/${state.clubId}/tournaments`), api(`/clubs/${state.clubId}/screen-devices`, { auth: true }),
  ]);
  const club = state.clubs.find((item) => Number(item.id) === state.clubId) || null;
  const daTournaments = (tournamentsData.items || []).filter((item) => item.provider_system === "dartsatlas");
  return {
    club,
    players: (playersData.items || []).map((player) => ({ ...player, member_id: null, member_name: null, member_link_source: null, dartsatlas_external_id: null })),
    members: [], tournaments: daTournaments, screens: screensData.items || [],
    dartsatlas: { season_external_id: "", tournament_count: daTournaments.length, player_count: 0, poll_interval_seconds: 8 },
    member_registry: { available: false, source: "admin_endpoint_unavailable", member_count: 0, linked_player_count: 0, unlinked_player_count: (playersData.items || []).length },
  };
}
async function loadAdmin() {
  try { state.admin = await dartsAdmin(); state.adminEndpointAvailable = true; }
  catch (error) { state.adminEndpointAvailable = false; state.admin = await loadAdminFallback(); state.admin.endpoint_error = error.message; }
}
async function loadKioskAdmin() {
  const [kiosks, pairing] = await Promise.all([
    api(`/clubs/${state.clubId}/kiosks`),
    api(`/clubs/${state.clubId}/kiosk-pairing-requests`, { auth: true }),
  ]);
  state.kiosks = kiosks.items || []; state.pairingRequests = pairing.items || [];
}
async function loadAll() {
  if (!state.clubId || state.loading) return;
  state.loading = true; el.refreshAllButton.disabled = true; el.refreshDartsAtlasButton.disabled = true; hideMessage(el.globalMessage);
  try {
    await Promise.all([loadAdmin(), loadLive(), loadKioskAdmin()]); renderAll();
    if (!state.adminEndpointAvailable) showMessage(el.globalMessage, "DartsAtlas-admin-endepunktet mangler på serveren. Kiosk, skjermer og grunnfunksjoner virker, men medlemskobling er midlertidig deaktivert.", "warning");
  } catch (error) { showMessage(el.globalMessage, error.message, "error"); }
  finally { state.loading = false; el.refreshAllButton.disabled = false; el.refreshDartsAtlasButton.disabled = false; }
}

function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["ok", "live", "ready", "in_progress", "completed", "fresh", "approved"].includes(value)) return "good";
  if (["error", "failed", "stale", "utilgjengelig"].includes(value)) return "bad";
  if (["pending", "assigned"].includes(value)) return "warning";
  return "neutral";
}
function formatDate(value) {
  if (!value) return "—"; const date = new Date(String(value).replace(" ", "T")); if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function formatAge(seconds) { if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "ukjent"; const value = Number(seconds); if (value < 60) return `${value} sek`; if (value < 3600) return `${Math.floor(value / 60)} min`; return `${Math.floor(value / 3600)} t`; }
function metric(label, value, hint, tone = "neutral") { return `<article class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint || "")}</small></article>`; }

function renderMetrics() {
  const admin = state.admin || {}, live = state.live || {}, registry = admin.member_registry || {}, tournament = live.tournament, feed = live.feed || {};
  const paired = state.kiosks.filter((kiosk) => Number(kiosk.is_paired) === 1).length;
  el.metrics.innerHTML = [
    metric("DartsAtlas", feed.status || "ukjent", `Sist data: ${formatAge(feed.age_seconds)}`, statusTone(feed.status)),
    metric("Aktiv turnering", tournament?.name || "Ingen", tournament?.status || "", tournament ? "good" : "neutral"),
    metric("Boards", String(state.kiosks.length), `${paired} paret til nettbrett`, state.kiosks.length ? "good" : "neutral"),
    metric("Medlemskobling", registry.available ? `${registry.linked_player_count || 0}/${admin.players?.length || 0}` : "Ikke tilgjengelig", registry.available ? "Medlemsregister tilkoblet" : "Venter på endpoint", registry.available ? "good" : "neutral"),
    metric("Live-skjermer", String(admin.screens?.length || 0), "Skjermkoder opprettet", admin.screens?.length ? "good" : "neutral"),
  ].join("");
}
function renderDartsAtlas() {
  const admin = state.admin || {}, live = state.live || {}, feed = live.feed || {}, da = admin.dartsatlas || {}, bootstrap = feed.bootstrap || {};
  el.seasonLabel.textContent = da.season_external_id ? `Sesong ${da.season_external_id}` : "Sesong ikke satt";
  el.dartsAtlasStatus.innerHTML = [
    ["Feed", feed.status || "ukjent", statusTone(feed.status)], ["Alder på data", formatAge(feed.age_seconds), "neutral"],
    ["Poll-intervall", `${da.poll_interval_seconds || feed.poll_interval_seconds || 8} sek`, "neutral"], ["Medlemskilde", feed.member_registry_source || admin.member_registry?.source || "ukjent", admin.member_registry?.available ? "good" : "neutral"],
    ["Bootstrap", bootstrap.status || "ikke kjørt", statusTone(bootstrap.status)], ["Importert", `${da.tournament_count || 0} turneringer / ${da.player_count || 0} DartsAtlas-spillere`, "neutral"],
  ].map(([label, value, tone]) => `<div class="status-item ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const tournaments = admin.tournaments || [];
  el.tournamentList.innerHTML = tournaments.length ? tournaments.map((tournament) => `<article class="list-row"><div><strong>${escapeHtml(tournament.name)}</strong><div class="row-meta"><span>${escapeHtml(formatDate(tournament.start_at))}</span><span>${escapeHtml(tournament.dartsatlas_external_id || "")}</span></div></div><div class="row-right"><span class="badge ${statusTone(tournament.status)}">${escapeHtml(tournament.status)}</span><small>${Number(tournament.completed_match_count || 0)}/${Number(tournament.match_count || 0)} kamper ferdig</small></div></article>`).join("") : `<div class="empty">Ingen DartsAtlas-turneringer er importert ennå.</div>`;
}

function kioskOptions(selected = 0) {
  return state.kiosks.map((kiosk) => `<option value="${Number(kiosk.id)}" ${Number(kiosk.id) === Number(selected) ? "selected" : ""}>Board ${Number(kiosk.board_number)} · ${escapeHtml(kiosk.name || kiosk.code)}</option>`).join("");
}
function renderKiosks() {
  const club = state.clubs.find((item) => Number(item.id) === state.clubId) || state.admin?.club || {};
  const clubCode = club.kiosk_pairing_code || "—";
  el.kioskClubCode.textContent = clubCode; el.kioskCount.textContent = `${state.kiosks.length} stk`; el.pairingCount.textContent = String(state.pairingRequests.length);

  if (!state.pairingRequests.length) {
    el.pairingRequestList.innerHTML = `<div class="empty compact-empty">Ingen nettbrett venter på godkjenning.</div>`;
  } else {
    el.pairingRequestList.innerHTML = state.pairingRequests.map((request) => `<article class="list-row pairing-row">
      <div><strong>${escapeHtml(request.device_name || "Nettbrett")}</strong><div class="pair-code">${escapeHtml(request.request_code)}</div><div class="row-meta"><span>Utløper ${escapeHtml(formatDate(request.expires_at))}</span></div></div>
      <div class="pair-actions"><select data-pair-kiosk="${escapeHtml(request.request_code)}"><option value="">Velg board …</option>${kioskOptions()}</select><button type="button" class="approve-pairing" data-request-code="${escapeHtml(request.request_code)}">Godkjenn</button></div>
    </article>`).join("");
  }

  el.kioskList.innerHTML = state.kiosks.length ? state.kiosks.map((kiosk) => `<article class="list-row board-row">
    <div class="board-number">${Number(kiosk.board_number)}</div>
    <div class="board-main"><strong>${escapeHtml(kiosk.name || `Board ${kiosk.board_number}`)}</strong><div class="row-meta"><span>${escapeHtml(kiosk.code)}</span><span>${Number(kiosk.is_paired) === 1 ? `Paret: ${escapeHtml(kiosk.paired_device_name || "nettbrett")}` : "Ikke paret"}</span></div></div>
    <div class="board-controls"><select class="scoring-mode" data-kiosk-id="${Number(kiosk.id)}"><option value="manual" ${kiosk.scoring_mode === "manual" ? "selected" : ""}>Manuell</option><option value="scolia" ${kiosk.scoring_mode === "scolia" ? "selected" : ""}>Scolia</option></select><span class="badge ${Number(kiosk.is_paired) === 1 ? "good" : "neutral"}">${Number(kiosk.is_paired) === 1 ? "Paret" : "Ledig"}</span>${Number(kiosk.is_paired) === 1 ? `<button type="button" class="reset-pairing secondary-action" data-kiosk-id="${Number(kiosk.id)}">Nullstill pairing</button>` : ""}</div>
  </article>`).join("") : `<div class="empty">Ingen boards er opprettet. Opprett første board til venstre.</div>`;

  document.querySelectorAll(".approve-pairing").forEach((button) => button.addEventListener("click", async () => {
    const requestCode = button.dataset.requestCode; const select = document.querySelector(`[data-pair-kiosk="${CSS.escape(requestCode)}"]`); const kioskId = Number(select?.value || 0);
    if (!kioskId) { showMessage(el.globalMessage, "Velg hvilket board nettbrettet skal pares mot.", "warning"); return; }
    button.disabled = true;
    try { await api(`/clubs/${state.clubId}/kiosk-pairing-requests/${encodeURIComponent(requestCode)}/approve`, { method: "POST", auth: true, body: { kiosk_id: kioskId } }); await loadKioskAdmin(); renderAll(); showMessage(el.globalMessage, "Nettbrettet er paret mot valgt board.", "success"); }
    catch (error) { showMessage(el.globalMessage, error.message, "error"); button.disabled = false; }
  }));
  document.querySelectorAll(".reset-pairing").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true; try { await api(`/clubs/${state.clubId}/kiosks/${Number(button.dataset.kioskId)}/reset-pairing`, { method: "POST", auth: true }); await loadKioskAdmin(); renderAll(); showMessage(el.globalMessage, "Pairing er nullstilt. Nettbrettet kan pares på nytt.", "success"); } catch (error) { showMessage(el.globalMessage, error.message, "error"); button.disabled = false; }
  }));
  document.querySelectorAll(".scoring-mode").forEach((select) => select.addEventListener("change", async () => {
    select.disabled = true; try { await api(`/clubs/${state.clubId}/kiosks/${Number(select.dataset.kioskId)}`, { method: "PATCH", auth: true, body: { scoring_mode: select.value } }); await loadKioskAdmin(); renderAll(); showMessage(el.globalMessage, `Scoringmodus er satt til ${select.value === "scolia" ? "Scolia" : "manuell"}.`, "success"); } catch (error) { showMessage(el.globalMessage, error.message, "error"); select.disabled = false; }
  }));
}

function memberOptions(selectedId) { const members = state.admin?.members || []; return [`<option value="">— Ikke koblet —</option>`, ...members.map((member) => `<option value="${Number(member.id)}" ${Number(member.id) === Number(selectedId) ? "selected" : ""}>${escapeHtml(member.navn)} (#${Number(member.id)})</option>`)].join(""); }
function renderMembers() {
  const registry = state.admin?.member_registry || {}, players = state.admin?.players || [], filtered = el.unlinkedOnly.checked ? players.filter((player) => !player.member_id) : players;
  el.memberRegistryStatus.innerHTML = registry.available ? `<span class="dot good"></span><strong>Samme medlemsregister som klubbadmin</strong><span>${Number(registry.member_count || 0)} medlemmer · ${Number(registry.unlinked_player_count || 0)} spillere mangler kobling</span>` : `<span class="dot neutral"></span><strong>Medlemskobling midlertidig utilgjengelig</strong><span>Resten av admin virker.</span>`;
  if (!filtered.length) { el.playerRows.innerHTML = `<tr><td colspan="4" class="empty-cell">Ingen spillere å vise.</td></tr>`; return; }
  el.playerRows.innerHTML = filtered.map((player) => { const source = player.dartsatlas_external_id ? "DartsAtlas" : "Lokal"; const label = player.member_id ? (player.member_link_source === "manual" ? "Manuell" : "Automatisk") : "Ikke koblet"; return `<tr><td><strong>${escapeHtml(player.display_name)}</strong>${player.nickname ? `<small>${escapeHtml(player.nickname)}</small>` : ""}</td><td><span class="badge neutral">${source}</span></td><td><select class="member-select" data-player-id="${Number(player.id)}" ${registry.available ? "" : "disabled"}>${memberOptions(player.member_id)}</select></td><td><span class="badge ${player.member_id ? "good" : "warning"}">${escapeHtml(label)}</span>${player.member_name ? `<small>${escapeHtml(player.member_name)} · #${Number(player.member_id)}</small>` : ""}</td></tr>`; }).join("");
  document.querySelectorAll(".member-select").forEach((select) => select.addEventListener("change", async () => { const playerId = Number(select.dataset.playerId), memberId = select.value ? Number(select.value) : null; select.disabled = true; try { await dartsAdmin({ action: "member-link", method: "POST", body: { player_id: playerId, member_id: memberId } }); await loadAdmin(); renderAll(); showMessage(el.globalMessage, memberId ? "Medlemskoblingen er lagret." : "Medlemskoblingen er fjernet.", "success"); } catch (error) { showMessage(el.globalMessage, `Kunne ikke lagre medlemskobling: ${error.message}`, "error"); await loadAdmin(); renderAll(); } }));
}
function renderScreens() {
  const screens = state.admin?.screens || []; el.screenCount.textContent = `${screens.length} stk`;
  el.screenList.innerHTML = screens.length ? screens.map((screen) => `<article class="list-row screen-row"><div><strong>${escapeHtml(screen.label || "Venue Screen")}</strong><div class="screen-code">${escapeHtml(screen.access_code || "")}</div><div class="row-meta"><span>Sist koblet: ${escapeHtml(formatDate(screen.last_connected_at))}</span></div></div><div class="row-right"><span class="badge ${Number(screen.is_active) === 1 ? "good" : "bad"}">${Number(screen.is_active) === 1 ? "Aktiv" : "Inaktiv"}</span><button type="button" class="copy-button" data-code="${escapeHtml(screen.access_code || "")}">Kopier kode</button></div></article>`).join("") : `<div class="empty">Ingen skjermkoder er laget ennå.</div>`;
  document.querySelectorAll(".copy-button").forEach((button) => button.addEventListener("click", async () => { const code = button.dataset.code || ""; try { await navigator.clipboard.writeText(code); button.textContent = "Kopiert"; setTimeout(() => { button.textContent = "Kopier kode"; }, 1200); } catch { showMessage(el.globalMessage, `Skjermkode: ${code}`, "info"); } }));
}
function renderAll() { const club = state.admin?.club || state.clubs.find((item) => Number(item.id) === state.clubId); el.clubName.textContent = club?.name || "Blindleia Darts"; renderMetrics(); renderDartsAtlas(); renderKiosks(); renderMembers(); renderScreens(); }
function showAdmin() { el.authGate.classList.add("hidden"); el.adminApp.classList.remove("hidden"); }
function showLogin() { el.adminApp.classList.add("hidden"); el.authGate.classList.remove("hidden"); }

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); hideMessage(el.loginMessage); const submit = el.loginForm.querySelector("button[type=submit]"); submit.disabled = true;
  try { const data = await api("/auth/login", { method: "POST", body: { username: el.loginUsername.value.trim(), password: el.loginPassword.value } }); persistToken(data.access_token); state.me = data.user; if (!["club_admin", "super_admin"].includes(state.me?.role || "")) throw new Error("Denne kontoen har ikke administratortilgang."); await loadClubs(); showAdmin(); await loadAll(); }
  catch (error) { persistToken(""); showMessage(el.loginMessage, error.message, "error"); }
  finally { submit.disabled = false; }
});
el.logoutButton.addEventListener("click", () => { persistToken(""); state.me = null; state.admin = null; state.live = null; showLogin(); });
el.refreshAllButton.addEventListener("click", () => loadAll()); el.refreshDartsAtlasButton.addEventListener("click", () => loadAll()); el.unlinkedOnly.addEventListener("change", renderMembers);
el.clubSelect.addEventListener("change", async () => { state.clubId = Number(el.clubSelect.value || 0); localStorage.setItem("bd:selectedClubId", String(state.clubId || "")); await loadAll(); });

el.copyKioskClubCode.addEventListener("click", async () => { const code = el.kioskClubCode.textContent.trim(); if (!code || code === "—") return; try { await navigator.clipboard.writeText(code); showMessage(el.globalMessage, `Klubbkode ${code} er kopiert.`, "success"); } catch { showMessage(el.globalMessage, `Klubbkode: ${code}`, "info"); } });
el.kioskForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const form = new FormData(el.kioskForm); const boardNumber = Number(form.get("board_number") || 0); if (boardNumber <= 0) return;
  const submit = el.kioskForm.querySelector("button[type=submit]"); submit.disabled = true;
  try { await api(`/clubs/${state.clubId}/kiosks`, { method: "POST", auth: true, body: { board_number: boardNumber, name: String(form.get("name") || "").trim() || `Board ${boardNumber}`, scoring_mode: String(form.get("scoring_mode") || "manual") } }); el.kioskForm.reset(); await loadKioskAdmin(); renderAll(); showMessage(el.globalMessage, `Board ${boardNumber} er opprettet.`, "success"); }
  catch (error) { showMessage(el.globalMessage, error.message, "error"); }
  finally { submit.disabled = false; }
});
el.screenForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const form = new FormData(el.screenForm); const label = String(form.get("label") || "").trim(); if (!label) return; const submit = el.screenForm.querySelector("button[type=submit]"); submit.disabled = true;
  try { const data = await api(`/clubs/${state.clubId}/screen-devices`, { method: "POST", auth: true, body: { label } }); el.screenForm.reset(); await loadAdmin(); renderAll(); showMessage(el.globalMessage, `Skjermkode ${data.device.access_code} er opprettet.`, "success"); }
  catch (error) { showMessage(el.globalMessage, error.message, "error"); }
  finally { submit.disabled = false; }
});

async function boot() {
  if (!state.token) { showLogin(); return; }
  const authenticated = await loadMe(); if (!authenticated) { showLogin(); return; }
  try { await loadClubs(); showAdmin(); await loadAll(); } catch (error) { showAdmin(); showMessage(el.globalMessage, error.message, "error"); }
}
boot();
