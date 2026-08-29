const API_ROOT = "../api/v1";

const seasonState = { seasons: [], tournaments: [], selectedId: 0 };

function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(localStorage.getItem("bd:selectedClubId") || document.getElementById("clubSelect")?.value || 0); }
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, { method: options.method || "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}
function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}
function fmtShortDate(value) {
  if (!value) return "Dato ikke satt";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
function statusLabel(value) { return ({ draft: "Utkast", active: "Aktiv", completed: "Avsluttet", archived: "Arkivert", ready: "Klar", in_progress: "Pågår" })[value] || value || "Ukjent"; }
function rankingLabel(season) {
  if (season.ranking_method === "linear") return "Lineær sesongranking";
  if (season.ranking_method === "elo") return "ELO";
  return `${Number(season.points_win ?? 2)} / ${Number(season.points_draw ?? 1)} / ${Number(season.points_loss ?? 0)} poeng (V/U/T)`;
}
function seasonTournaments(seasonId) { return seasonState.tournaments.filter((t) => Number(t.season_id || 0) === Number(seasonId)); }
function activeSeason() { return seasonState.seasons.find((s) => s.status === "active" || Number(s.is_active) === 1) || null; }
function selectedSeason() { return seasonState.seasons.find((s) => Number(s.id) === Number(seasonState.selectedId)) || activeSeason() || seasonState.seasons[0] || null; }

function installStyles() {
  if (document.getElementById("seasonUxStyles")) return;
  const style = document.createElement("style");
  style.id = "seasonUxStyles";
  style.textContent = `
    .season-page{display:grid;gap:18px}.season-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.season-page-head h2{margin:.15rem 0 .35rem}.season-primary{border:1px solid #cbdcf3;border-radius:18px;padding:20px;background:linear-gradient(135deg,#f8fbff,#fff);box-shadow:0 8px 24px rgba(16,43,76,.06)}
    .season-primary-top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.season-primary h3{font-size:1.55rem;margin:.15rem 0 .35rem}.season-primary-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}.season-primary-meta span{font-size:.86rem;color:var(--muted,#667085)}
    .season-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}.season-kpi{padding:12px 14px;border:1px solid #e0e7ef;border-radius:13px;background:#fff}.season-kpi strong{display:block;font-size:1.25rem}.season-kpi span{font-size:.78rem;color:var(--muted,#667085)}
    .season-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.season-tabs{display:flex;gap:6px;padding:4px;border:1px solid #dde4ed;border-radius:12px;background:#f7f9fc;width:max-content;max-width:100%;overflow:auto}.season-tabs button{border:0;background:transparent;color:inherit;padding:9px 13px;border-radius:9px;white-space:nowrap}.season-tabs button.active{background:#fff;box-shadow:0 1px 5px rgba(16,43,76,.12);font-weight:700}
    .season-detail{display:grid;gap:14px}.season-tournament-list{display:grid;gap:8px}.season-tournament{display:grid;grid-template-columns:78px minmax(0,1fr) auto;gap:14px;align-items:center;padding:13px 14px;border:1px solid #e1e7ef;border-radius:13px;background:#fff}.season-tournament-date{font-size:.78rem;color:var(--muted,#667085)}.season-tournament-main strong{display:block}.season-tournament-main small{color:var(--muted,#667085)}
    .season-rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.season-rule{padding:14px;border:1px solid #e1e7ef;border-radius:13px;background:#fff}.season-rule span{display:block;font-size:.75rem;color:var(--muted,#667085);margin-bottom:4px}.season-rule strong{font-size:.98rem}
    .season-history{display:grid;gap:9px}.season-history-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px;border:1px solid #e1e7ef;border-radius:13px;background:#fff;cursor:pointer}.season-history-row:hover{border-color:#9bbce7}.season-history-row small{color:var(--muted,#667085)}
    .season-create-wrap{border-top:1px solid #e1e7ef;padding-top:16px}.season-create-toggle{display:flex;justify-content:space-between;align-items:center;gap:12px}.season-form{display:grid;gap:12px;margin-top:14px;padding:16px;border:1px solid #e1e7ef;border-radius:14px;background:#f8fafc}.season-form-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}.season-form label{display:flex;flex-direction:column;gap:5px}.season-form-actions{display:flex;justify-content:flex-end;gap:8px}.season-edit-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}.season-edit-grid label{display:flex;flex-direction:column;gap:5px}.season-message{margin-top:10px}.season-empty{padding:24px;text-align:center;border:1px dashed #ccd6e3;border-radius:14px;color:var(--muted,#667085)}
    #seasonStandingsCard{margin-top:0}.season-table-mobile-note{display:none}
    @media(max-width:760px){.season-page{gap:14px}.season-page-head{display:block}.season-page-head .button{width:100%;margin-top:10px}.season-primary{padding:16px}.season-primary-top{display:block}.season-actions{justify-content:flex-start;margin-top:14px}.season-actions .button{flex:1}.season-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.season-tabs{width:100%}.season-tabs button{flex:1}.season-tournament{grid-template-columns:1fr auto;gap:6px 10px}.season-tournament-date{grid-column:1/-1}.season-rules{grid-template-columns:1fr}.season-history-row{grid-template-columns:1fr}.season-form-grid,.season-edit-grid{grid-template-columns:1fr}.season-form-actions{flex-direction:column}.season-form-actions .button{width:100%}.season-table-mobile-note{display:block}}
  `;
  document.head.appendChild(style);
}

function ensureView() {
  const nav = document.querySelector(".portal-menu");
  const main = document.querySelector("main.main");
  if (!nav || !main) return;
  installStyles();
  if (!nav.querySelector('a[href="#seasons"]')) {
    const link = document.createElement("a"); link.href = "#seasons"; link.dataset.portalNav = "1"; link.textContent = "Sesonger";
    nav.querySelector('a[href="#tournaments"]')?.after(link);
  }
  if (document.getElementById("seasons")) return;
  const section = document.createElement("section");
  section.id = "seasons"; section.dataset.portalSection = "seasons"; section.className = "panel season-page";
  section.innerHTML = `
    <div class="season-page-head"><div><p class="eyebrow">Konkurranseperioder</p><h2>Sesonger</h2><p class="muted">Sesongen er rammen rundt turneringene, tabellen og sesongvinneren.</p></div><button id="seasonNewButton" type="button" class="button secondary">Ny sesong</button></div>
    <div id="seasonMessage" class="message hidden season-message"></div>
    <div id="seasonCurrent"><div class="season-empty">Laster sesonger …</div></div>
    <div id="seasonWorkspace" class="hidden"><div class="season-tabs" role="tablist"><button type="button" class="active" data-season-tab="overview">Oversikt</button><button type="button" data-season-tab="tournaments">Turneringer</button><button type="button" data-season-tab="rules">Sesongregler</button></div><div id="seasonDetail" class="season-detail"></div></div>
    <div id="seasonStandingsCard" class="claim-admin-card hidden"><div class="panel-head"><div><p class="eyebrow">Sesongtabell</p><h3 id="seasonStandingsTitle">Tabell</h3></div><button id="seasonStandingsClose" type="button" class="button quiet">Lukk</button></div><div id="seasonStandings"></div></div>
    <div><div class="subsection-head"><h3>Tidligere sesonger</h3><span id="seasonCount" class="pill">0</span></div><div id="seasonHistory" class="season-history"></div></div>
    <div class="season-create-wrap"><div class="season-create-toggle"><div><strong>Opprett ny sesong</strong><p class="muted" style="margin:.2rem 0 0">Kopier gjerne oppsettet fra aktiv eller siste sesong.</p></div></div>
      <form id="seasonForm" class="season-form hidden"><div class="season-form-grid"><label><span>Navn</span><input name="name" maxlength="150" placeholder="Mandagsserien Vår 2027" required></label><label><span>Fra</span><input name="starts_on" type="date"></label><label><span>Til</span><input name="ends_on" type="date"></label></div><div class="season-form-grid"><label><span>Sesongtabell</span><select name="ranking_method"><option value="linear">Lineær</option><option value="match_points">Kamp-poeng</option><option value="elo">ELO</option></select></label><label><span>Seier</span><input name="points_win" type="number" min="0" step="0.5" value="2"></label><label><span>Uavgjort / tap</span><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><input name="points_draw" aria-label="Poeng uavgjort" type="number" min="0" step="0.5" value="1"><input name="points_loss" aria-label="Poeng tap" type="number" min="0" step="0.5" value="0"></div></label></div><label class="inline-check"><input name="activate" type="checkbox"><span>Gjør til aktiv sesong med én gang</span></label><div class="season-form-actions"><button id="seasonCopyPrevious" type="button" class="button secondary">Kopier regler fra forrige</button><button type="submit" class="button">Opprett sesong</button></div></form>
    </div>`;
  document.getElementById("tournaments")?.after(section);

  section.querySelector("#seasonNewButton")?.addEventListener("click", () => { const form = section.querySelector("#seasonForm"); form?.classList.remove("hidden"); form?.querySelector('[name="name"]')?.focus(); form?.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  section.querySelector("#seasonCopyPrevious")?.addEventListener("click", copyPreviousRules);
  section.querySelector("#seasonForm")?.addEventListener("submit", createSeason);
  section.querySelector("#seasonStandingsClose")?.addEventListener("click", () => section.querySelector("#seasonStandingsCard")?.classList.add("hidden"));
  section.querySelectorAll("[data-season-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.seasonTab)));
}

function message(text, tone = "info") { const node = document.getElementById("seasonMessage"); if (!node) return; node.textContent = text; node.className = `message ${tone} season-message`; }
function clearMessage() { document.getElementById("seasonMessage")?.classList.add("hidden"); }

function renderCurrent() {
  const root = document.getElementById("seasonCurrent");
  const workspace = document.getElementById("seasonWorkspace");
  if (!root || !workspace) return;
  const season = selectedSeason();
  if (!season) { root.innerHTML = `<div class="season-empty"><strong>Ingen sesong ennå</strong><br>Opprett første sesong for å samle turneringene i en konkurranseperiode.</div>`; workspace.classList.add("hidden"); return; }
  seasonState.selectedId = Number(season.id);
  const tournaments = seasonTournaments(season.id);
  const completed = tournaments.filter((t) => t.status === "completed").length;
  const players = new Set(); tournaments.forEach((t) => { if (Number(t.registration_count || 0)) players.add(t.id); });
  const next = tournaments.find((t) => t.status !== "completed" && t.start_at && new Date(String(t.start_at).replace(" ", "T")) >= new Date()) || tournaments.find((t) => t.status !== "completed") || null;
  root.innerHTML = `<article class="season-primary"><div class="season-primary-top"><div><p class="eyebrow">${season.status === "active" ? "Aktiv sesong" : "Valgt sesong"}</p><h3>${esc(season.name)}</h3><div class="season-primary-meta"><span>${esc(fmtDate(season.starts_on))} – ${esc(fmtDate(season.ends_on))}</span><span>·</span><span>${esc(rankingLabel(season))}</span></div></div><div class="season-actions"><span class="badge ${season.status === "active" ? "good" : "neutral"}">${esc(statusLabel(season.status))}</span><button type="button" class="button secondary" data-current-action="table">Se tabell</button>${season.status !== "completed" ? `<button type="button" class="button secondary" data-current-action="edit">Rediger</button>` : ""}${season.status === "active" ? `<button type="button" class="button quiet" data-current-action="complete">Avslutt</button>` : season.status !== "completed" ? `<button type="button" class="button" data-current-action="activate">Aktiver</button>` : ""}</div></div><div class="season-kpis"><div class="season-kpi"><strong>${tournaments.length}</strong><span>Turneringer</span></div><div class="season-kpi"><strong>${completed}</strong><span>Gjennomført</span></div><div class="season-kpi"><strong>${Math.max(0, tournaments.length - completed)}</strong><span>Gjenstår</span></div><div class="season-kpi"><strong>${next ? esc(fmtShortDate(next.start_at)) : "—"}</strong><span>Neste turnering</span></div></div></article>`;
  workspace.classList.remove("hidden");
  root.querySelector('[data-current-action="table"]')?.addEventListener("click", () => showStandings(season.id));
  root.querySelector('[data-current-action="edit"]')?.addEventListener("click", () => renderDetail("rules", true));
  root.querySelector('[data-current-action="activate"]')?.addEventListener("click", () => activateSeason(season.id));
  root.querySelector('[data-current-action="complete"]')?.addEventListener("click", () => completeSeason(season.id));
  renderDetail("overview");
}

function setTab(tab) {
  document.querySelectorAll("[data-season-tab]").forEach((b) => b.classList.toggle("active", b.dataset.seasonTab === tab));
  renderDetail(tab);
}

function renderDetail(tab = "overview", editing = false) {
  const root = document.getElementById("seasonDetail"); const season = selectedSeason(); if (!root || !season) return;
  document.querySelectorAll("[data-season-tab]").forEach((b) => b.classList.toggle("active", b.dataset.seasonTab === tab));
  const tournaments = seasonTournaments(season.id);
  if (tab === "tournaments") {
    root.innerHTML = `<div class="season-tournament-list">${tournaments.length ? tournaments.map((t) => `<article class="season-tournament"><div class="season-tournament-date">${esc(fmtShortDate(t.start_at))}</div><div class="season-tournament-main"><strong>${esc(t.name)}</strong><small>${Number(t.registration_count || 0)} påmeldte · ${Number(t.completed_match_count || 0)}/${Number(t.match_count || 0)} kamper</small></div><span class="badge ${t.status === "completed" ? "good" : t.status === "in_progress" ? "warning" : "neutral"}">${esc(statusLabel(t.status))}</span></article>`).join("") : `<div class="season-empty">Ingen turneringer er koblet til denne sesongen ennå.</div>`}</div>`;
    return;
  }
  if (tab === "rules") {
    if (editing && season.status !== "completed") {
      root.innerHTML = `<form id="seasonEditForm" class="season-form"><div class="season-edit-grid"><label><span>Navn</span><input name="name" value="${esc(season.name)}" required></label><label><span>Fra</span><input name="starts_on" type="date" value="${esc(season.starts_on || "")}"></label><label><span>Til</span><input name="ends_on" type="date" value="${esc(season.ends_on || "")}"></label></div><div class="season-edit-grid"><label><span>Rankingmodell</span><select name="ranking_method"><option value="linear" ${season.ranking_method === "linear" ? "selected" : ""}>Lineær</option><option value="match_points" ${season.ranking_method === "match_points" ? "selected" : ""}>Kamp-poeng</option><option value="elo" ${season.ranking_method === "elo" ? "selected" : ""}>ELO</option></select></label><label><span>Seier / uavgjort / tap</span><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"><input name="points_win" type="number" step=".5" min="0" value="${Number(season.points_win ?? 2)}"><input name="points_draw" type="number" step=".5" min="0" value="${Number(season.points_draw ?? 1)}"><input name="points_loss" type="number" step=".5" min="0" value="${Number(season.points_loss ?? 0)}"></div></label></div><div class="season-form-actions"><button type="button" class="button secondary" id="seasonEditCancel">Avbryt</button><button type="submit" class="button">Lagre sesong</button></div></form>`;
      root.querySelector("#seasonEditCancel")?.addEventListener("click", () => renderDetail("rules"));
      root.querySelector("#seasonEditForm")?.addEventListener("submit", updateSeason);
    } else {
      root.innerHTML = `<div class="season-rules"><div class="season-rule"><span>Rankingmodell</span><strong>${esc(rankingLabel(season))}</strong></div><div class="season-rule"><span>Periode</span><strong>${esc(fmtDate(season.starts_on))} – ${esc(fmtDate(season.ends_on))}</strong></div><div class="season-rule"><span>Status</span><strong>${esc(statusLabel(season.status))}</strong></div></div>${season.status !== "completed" ? `<div style="margin-top:12px"><button id="seasonEditRules" type="button" class="button secondary">Rediger sesong og regler</button></div>` : ""}`;
      root.querySelector("#seasonEditRules")?.addEventListener("click", () => renderDetail("rules", true));
    }
    return;
  }
  const next = tournaments.find((t) => t.status !== "completed") || null;
  root.innerHTML = `<div class="season-rules"><div class="season-rule"><span>Fremdrift</span><strong>${Number(season.completed_tournament_count || 0)} av ${Number(season.tournament_count || 0)} turneringer ferdig</strong></div><div class="season-rule"><span>Neste</span><strong>${next ? `${esc(fmtShortDate(next.start_at))} · ${esc(next.name)}` : "Ingen planlagt"}</strong></div><div class="season-rule"><span>${season.champion_name ? "Sesongvinner" : "Tabell"}</span><strong>${season.champion_name ? esc(season.champion_name) : "Løpende gjennom sesongen"}</strong></div></div>`;
}

function renderHistory() {
  const root = document.getElementById("seasonHistory"); const count = document.getElementById("seasonCount"); if (!root || !count) return;
  const current = selectedSeason(); const items = seasonState.seasons.filter((s) => !current || Number(s.id) !== Number(current.id)); count.textContent = `${items.length} stk`;
  root.innerHTML = items.length ? items.map((s) => `<article class="season-history-row" data-season-select="${Number(s.id)}"><div><strong>${esc(s.name)}</strong><div><small>${esc(fmtDate(s.starts_on))} – ${esc(fmtDate(s.ends_on))} · ${Number(s.completed_tournament_count || 0)}/${Number(s.tournament_count || 0)} turneringer${s.champion_name ? ` · Vinner: ${esc(s.champion_name)}` : ""}</small></div></div><span class="badge ${s.status === "active" ? "good" : "neutral"}">${esc(statusLabel(s.status))}</span></article>`).join("") : `<div class="season-empty">Ingen tidligere sesonger.</div>`;
  root.querySelectorAll("[data-season-select]").forEach((row) => row.addEventListener("click", () => { seasonState.selectedId = Number(row.dataset.seasonSelect); document.getElementById("seasonStandingsCard")?.classList.add("hidden"); renderCurrent(); renderHistory(); window.scrollTo({ top: document.getElementById("seasons")?.offsetTop || 0, behavior: "smooth" }); }));
}

function copyPreviousRules() {
  const source = activeSeason() || seasonState.seasons[0]; const form = document.getElementById("seasonForm"); if (!source || !form) { message("Ingen tidligere sesong å kopiere fra.", "warning"); return; }
  form.querySelector('[name="ranking_method"]').value = source.ranking_method || "linear";
  form.querySelector('[name="points_win"]').value = Number(source.points_win ?? 2);
  form.querySelector('[name="points_draw"]').value = Number(source.points_draw ?? 1);
  form.querySelector('[name="points_loss"]').value = Number(source.points_loss ?? 0);
  message(`Reglene fra ${source.name} er kopiert.`, "success");
}

async function createSeason(event) {
  event.preventDefault(); clearMessage(); const form = event.currentTarget; const id = clubId(); if (!id) return; const data = new FormData(form); const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try { const result = await api(`/clubs/${id}/seasons`, { method: "POST", body: { name: data.get("name"), starts_on: data.get("starts_on"), ends_on: data.get("ends_on"), ranking_method: data.get("ranking_method"), points_win: Number(data.get("points_win") || 0), points_draw: Number(data.get("points_draw") || 0), points_loss: Number(data.get("points_loss") || 0), activate: data.get("activate") === "on" } }); form.reset(); form.classList.add("hidden"); seasonState.selectedId = Number(result.season?.id || 0); message("Sesongen er opprettet.", "success"); await load(); } catch (error) { message(error.message, "error"); } finally { button.disabled = false; }
}
async function updateSeason(event) {
  event.preventDefault(); const season = selectedSeason(); if (!season) return; const form = event.currentTarget; const data = new FormData(form); const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try { await api(`/seasons/${season.id}`, { method: "PATCH", body: { name: data.get("name"), starts_on: data.get("starts_on"), ends_on: data.get("ends_on"), ranking_method: data.get("ranking_method"), points_win: Number(data.get("points_win") || 0), points_draw: Number(data.get("points_draw") || 0), points_loss: Number(data.get("points_loss") || 0) } }); message("Sesongen er oppdatert.", "success"); await load(); setTab("rules"); } catch (error) { message(error.message, "error"); } finally { button.disabled = false; }
}
async function activateSeason(id) { try { await api(`/seasons/${Number(id)}/activate`, { method: "POST", body: {} }); seasonState.selectedId = Number(id); message("Sesongen er nå aktiv.", "success"); await load(); } catch (error) { message(error.message, "error"); } }
async function completeSeason(id) { if (!confirm("Avslutte sesongen og låse sesongvinneren fra gjeldende tabell?")) return; try { await api(`/seasons/${Number(id)}/complete`, { method: "POST", body: {} }); message("Sesongen er avsluttet.", "success"); await load(); await showStandings(Number(id)); } catch (error) { message(error.message, "error"); } }

async function showStandings(seasonId) {
  try {
    const data = await api(`/seasons/${seasonId}/standings`); const card = document.getElementById("seasonStandingsCard"); const title = document.getElementById("seasonStandingsTitle"); const table = document.getElementById("seasonStandings"); if (!card || !title || !table) return;
    title.textContent = data.season.name; const elo = data.season.ranking_method === "elo";
    table.innerHTML = data.items.length ? `<p class="muted" style="margin:0 0 .75rem">Tie-break ved lik hovedscore: leg differanse → 3DA → innbyrdes.</p><p class="season-table-mobile-note muted">Dra tabellen sidelengs for alle tall.</p><div class="table-wrap"><table><thead><tr><th>#</th><th>Spiller</th><th>Turn.</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg +/-</th><th>3DA</th><th>${elo ? "ELO" : "Poeng"}</th></tr></thead><tbody>${data.items.map((row) => `<tr><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.tournaments)}</td><td>${Number(row.matches_played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td>${Number(row.three_dart_average || 0) > 0 ? Number(row.three_dart_average).toFixed(2) : "—"}</td><td><strong>${elo ? Number(row.elo_rating).toFixed(0) : Number(row.points).toLocaleString("nb-NO", { maximumFractionDigits: 2 })}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="season-empty">Ingen resultater i denne sesongen ennå.</div>`;
    card.classList.remove("hidden"); card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) { message(error.message, "error"); }
}

async function load() {
  ensureView(); const id = clubId(); if (!id || !token()) return;
  try {
    const [seasonData, tournamentData] = await Promise.all([api(`/clubs/${id}/seasons`), api(`/clubs/${id}/tournaments`)]);
    seasonState.seasons = seasonData.items || []; seasonState.tournaments = tournamentData.items || [];
    if (!seasonState.seasons.some((s) => Number(s.id) === Number(seasonState.selectedId))) seasonState.selectedId = Number(activeSeason()?.id || seasonState.seasons[0]?.id || 0);
    renderCurrent(); renderHistory();
  } catch (error) { message(error.message, "error"); }
}

ensureView();
document.getElementById("clubSelect")?.addEventListener("change", () => { seasonState.selectedId = 0; setTimeout(load, 50); });
window.addEventListener("storage", load);
window.addEventListener("bd:portal-view", (event) => { if (event.detail?.target === "seasons") load(); });
setTimeout(load, 500);
