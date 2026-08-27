const API_ROOT = "../api/v1";

const state = {
  clubId: Number(localStorage.getItem("bd:playerClubId") || 0),
  tournaments: [],
  players: [],
  elo: [],
  summaries: [],
  seasons: [],
  tournamentMatches: [],
};

const el = {
  clubSelect: document.getElementById("clubSelect"),
  refreshButton: document.getElementById("refreshButton"),
  eloTable: document.getElementById("eloTable"),
  seasonStandings: document.getElementById("seasonStandings"),
  tableTournamentSelect: document.getElementById("tableTournamentSelect"),
  groupTables: document.getElementById("groupTables"),
  tournamentMatches: document.getElementById("tournamentMatches"),
  playerDirectory: document.getElementById("playerDirectory"),
  playerProfile: document.getElementById("playerProfile"),
  summaryList: document.getElementById("summaryList"),
  myMatchList: document.getElementById("myMatchList"),
  matchDetailDialog: document.getElementById("matchDetailDialog"),
  matchDetailContent: document.getElementById("matchDetailContent"),
};

function portalToken() { return localStorage.getItem("bd:token") || ""; }

async function api(path, { auth = false } = {}) {
  const headers = {};
  if (auth && portalToken()) headers.Authorization = `Bearer ${portalToken()}`;
  const response = await fetch(`${API_ROOT}${path}`, { headers, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  }
  return payload.data;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function summaryText(value) {
  return esc(value).replace(/\r?\n/g, "<br>");
}

function hasRecordedStats(player) {
  return Number(player.matches_played || 0) > 0
    || Number(player.baseline_played || 0) > 0
    || Number(player.score_180 || 0) > 0
    || Number(player.highest_checkout || 0) > 0
    || Number(player.three_dart_average || player.recorded_average || 0) > 0;
}

async function resolveClubId() {
  const fromStorage = Number(localStorage.getItem("bd:playerClubId") || 0);
  const fromSelect = Number(el.clubSelect?.value || 0);
  if (fromStorage || fromSelect) {
    state.clubId = fromStorage || fromSelect;
    return state.clubId;
  }
  const clubs = await api("/clubs");
  state.clubId = Number(clubs.items?.[0]?.id || 0);
  return state.clubId;
}

async function loadPortalContent() {
  const clubId = await resolveClubId();
  if (!clubId) return;

  const [players, elo, summaries, tournaments, seasons] = await Promise.all([
    api(`/clubs/${clubId}/player-directory`),
    api(`/clubs/${clubId}/elo`),
    api(`/clubs/${clubId}/summaries`),
    api(`/clubs/${clubId}/registration-tournaments`),
    api(`/clubs/${clubId}/seasons`),
  ]);

  state.players = (players.items || []).filter(hasRecordedStats);
  state.elo = (elo.items || []).filter(hasRecordedStats);
  state.summaries = summaries.items || [];
  state.tournaments = tournaments.items || [];
  state.seasons = seasons.items || [];
  renderElo();
  renderPlayers();
  renderSummaries();
  renderTournamentPicker();
  bindTournamentTabs();
  await Promise.all([loadTournamentTable(), loadSeasonStandings(), loadMyMatches()]);
}

function renderElo() {
  if (!state.elo.length) {
    el.eloTable.innerHTML = `<div class="mini-card"><p class="muted">Ingen registrert statistikk ennå.</p></div>`;
    return;
  }
  el.eloTable.innerHTML = `
    <div class="table-scroll">
      <table class="portal-table elo-table">
        <thead><tr><th>#</th><th>Spiller</th><th>ELO</th><th>Kamper</th><th>Seire</th><th>3DA</th></tr></thead>
        <tbody>${state.elo.map((row, index) => `
          <tr data-player-profile="${Number(row.id)}">
            <td>${index + 1}</td>
            <td><strong>${esc(row.display_name)}</strong>${row.nickname ? `<small>${esc(row.nickname)}</small>` : ""}</td>
            <td>${Number(row.elo_rating || 1000).toFixed(1)}</td>
            <td>${Number(row.baseline_played ?? row.matches_played ?? 0)}</td>
            <td>${Number(row.matches_won || 0)}</td>
            <td>${Number(row.three_dart_average || row.recorded_average || 0) > 0 ? Number(row.three_dart_average || row.recorded_average).toFixed(2) : "—"}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
  bindProfileLinks(el.eloTable);
}

function renderPlayers() {
  if (!state.players.length) {
    el.playerDirectory.innerHTML = `<div class="mini-card"><p class="muted">Ingen spillere med registrerte kamper eller statistikk ennå.</p></div>`;
    return;
  }
  const sorted = [...state.players].sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), "nb"));
  el.playerDirectory.innerHTML = sorted.map((player) => `
    <button type="button" class="player-card" data-player-profile="${Number(player.id)}">
      <span class="player-card-name">${esc(player.display_name)}</span>
      <span class="player-card-meta">ELO ${Number(player.elo_rating || 1000).toFixed(1)} · ${Number(player.matches_played || player.baseline_played || 0)} kamper${Number(player.three_dart_average || 0) > 0 ? ` · 3DA ${Number(player.three_dart_average).toFixed(2)}` : ""}</span>
    </button>`).join("");
  bindProfileLinks(el.playerDirectory);
}

function bindProfileLinks(root) {
  root.querySelectorAll("[data-player-profile]").forEach((item) => item.addEventListener("click", () => {
    loadPlayerProfile(Number(item.dataset.playerProfile)).catch((error) => renderProfileError(error.message));
  }));
}

function resultLabel(result) {
  return result === "win" ? "Seier" : result === "draw" ? "Uavgjort" : "Tap";
}

function renderHistoryRows(matches) {
  return matches.map((match) => `
    <button type="button" class="history-row history-row-button" data-match-detail="${Number(match.id)}">
      <div>
        <strong>${esc(resultLabel(match.result))} mot ${esc(match.opponent_name || "Motstander")}</strong>
        <small>${esc(match.tournament_name)}${match.round_label ? ` · ${esc(match.round_label)}` : ""}${match.average !== null && match.average !== undefined ? ` · 3DA ${Number(match.average).toFixed(2)}` : ""}</small>
      </div>
      <span>${esc(formatDate(match.finished_at || match.start_at))}</span>
    </button>`).join("");
}

async function loadPlayerProfile(playerId) {
  el.playerProfile.classList.remove("hidden");
  el.playerProfile.innerHTML = `<p class="muted">Henter spillerprofil …</p>`;
  const data = await api(`/players/${playerId}/profile`);
  const player = data.player || {};
  const stats = data.stats || {};
  const elo = data.elo || {};
  const recent = data.recent_matches || [];
  const history = data.elo_history || [];

  el.playerProfile.innerHTML = `
    <div class="profile-head">
      <div>
        <p class="eyebrow">Spillerprofil</p>
        <h2>${esc(player.display_name)}</h2>
        ${player.nickname ? `<p class="muted">${esc(player.nickname)}</p>` : ""}
      </div>
      <button type="button" class="profile-close ghost">Lukk</button>
    </div>
    <div class="stats-grid profile-stats">
      <div class="stat-card"><small>ELO</small><strong>${Number(elo.rating || 1000).toFixed(1)}</strong></div>
      <div class="stat-card stat-card-accent"><small>3-dart snitt</small><strong>${Number(stats.three_dart_average || 0) > 0 ? Number(stats.three_dart_average).toFixed(2) : "—"}</strong></div>
      <div class="stat-card"><small>Kamper</small><strong>${Number(stats.matches_played || 0)}</strong></div>
      <div class="stat-card"><small>Seire</small><strong>${Number(stats.matches_won || 0)}</strong></div>
      <div class="stat-card"><small>Seiersprosent</small><strong>${Number(stats.win_percentage || 0).toFixed(1)}%</strong></div>
      <div class="stat-card"><small>Høy checkout</small><strong>${Number(stats.highest_checkout || 0)}</strong></div>
      <div class="stat-card"><small>Checkout %</small><strong>${stats.checkout_percentage === null || stats.checkout_percentage === undefined ? "—" : `${Number(stats.checkout_percentage).toFixed(1)}%`}</strong></div>
      <div class="stat-card"><small>180</small><strong>${Number(stats.visits_180 || 0)}</strong></div>
      <div class="stat-card"><small>140+</small><strong>${Number(stats.visits_140_plus || 0)}</strong></div>
      <div class="stat-card"><small>100+</small><strong>${Number(stats.visits_100_plus || 0)}</strong></div>
    </div>
    <div class="profile-section">
      <div class="section-head"><h3>Siste kamper</h3>${recent.length ? `<button type="button" class="ghost profile-all-matches" data-player="${Number(player.id)}">Se alle</button>` : ""}</div>
      <div class="profile-match-history">${recent.length ? renderHistoryRows(recent) : `<p class="muted">Ingen fullførte kamper registrert.</p>`}</div>
    </div>
    <div class="profile-section">
      <h3>ELO-historikk</h3>
      ${history.length ? history.slice(0, 8).map((entry) => `<div class="history-row"><div><strong>${Number(entry.rating).toFixed(1)}</strong><small>${esc(entry.tournament_name || entry.scope_type)}</small></div><span>${esc(formatDate(entry.calculated_at))}</span></div>`).join("") : `<p class="muted">Ingen ELO-historikk registrert ennå.</p>`}
    </div>`;

  el.playerProfile.querySelector(".profile-close")?.addEventListener("click", () => el.playerProfile.classList.add("hidden"));
  bindMatchDetailLinks(el.playerProfile);
  el.playerProfile.querySelector(".profile-all-matches")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const data = await api(`/players/${Number(button.dataset.player)}/matches`);
      const container = el.playerProfile.querySelector(".profile-match-history");
      if (container) container.innerHTML = data.items?.length ? renderHistoryRows(data.items) : `<p class="muted">Ingen fullførte kamper registrert.</p>`;
      bindMatchDetailLinks(el.playerProfile);
      button.remove();
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  });
  el.playerProfile.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderProfileError(message) {
  el.playerProfile.classList.remove("hidden");
  el.playerProfile.innerHTML = `<p class="muted">${esc(message)}</p>`;
}

function renderSummaries() {
  if (!state.summaries.length) {
    el.summaryList.innerHTML = `<div class="mini-card"><p class="muted">Ingen publiserte oppsummeringer ennå.</p></div>`;
    return;
  }
  el.summaryList.innerHTML = state.summaries.map((summary, index) => `
    <article class="summary-card ${index > 2 ? "summary-collapsed" : ""}">
      <div class="section-head">
        <div><p class="eyebrow">${esc(formatDate(summary.start_at))}</p><h3>${esc(summary.title)}</h3></div>
        <span class="pill">${esc(summary.tournament_name)}</span>
      </div>
      <div class="summary-body">${summaryText(summary.body_text)}</div>
    </article>`).join("");
}

function renderTournamentPicker() {
  const eligible = state.tournaments.filter((tournament) => Number(tournament.registration_count || 0) > 0 || tournament.group_drawn_at || tournament.status === "completed");
  el.tableTournamentSelect.innerHTML = eligible.length
    ? eligible.map((tournament) => `<option value="${Number(tournament.id)}">${esc(tournament.name)} · ${esc(formatDate(tournament.start_at))}</option>`).join("")
    : `<option value="">Ingen turneringer med deltakere</option>`;
}

async function loadTournamentTable() {
  const tournamentId = Number(el.tableTournamentSelect.value || 0);
  if (!tournamentId) {
    el.groupTables.innerHTML = `<div class="mini-card"><p class="muted">Ingen gruppetabell å vise ennå.</p></div>`;
    if (el.tournamentMatches) el.tournamentMatches.innerHTML = `<div class="mini-card"><p class="muted">Ingen kamper å vise ennå.</p></div>`;
    return;
  }
  el.groupTables.innerHTML = `<p class="muted">Henter tabell …</p>`;
  if (el.tournamentMatches) el.tournamentMatches.innerHTML = `<p class="muted">Henter kamper …</p>`;
  try {
    const [tableData, matchData] = await Promise.all([
      api(`/tournaments/${tournamentId}/tables`),
      api(`/tournaments/${tournamentId}/results`),
    ]);
    const groups = tableData.groups || [];
    el.groupTables.innerHTML = `<p class="tie-break-note">Ved likt: leg differanse → 3DA → innbyrdes.</p>${groups.map((group) => `
      <article class="table-card">
        <h3>${esc(group.name)}</h3>
        <div class="table-scroll"><table class="portal-table compact-table">
          <thead><tr><th>#</th><th>Spiller</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg</th><th>3DA</th><th>P</th></tr></thead>
          <tbody>${(group.rows || []).map((row) => `<tr data-player-profile="${Number(row.player_id)}"><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td>${Number(row.three_dart_average || 0) > 0 ? Number(row.three_dart_average).toFixed(2) : "—"}</td><td><strong>${Number(row.points)}</strong></td></tr>`).join("")}</tbody>
        </table></div>
      </article>`).join("")}`;
    bindProfileLinks(el.groupTables);
    state.tournamentMatches = matchData.items || [];
    renderTournamentMatches();
  } catch (error) {
    el.groupTables.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
    if (el.tournamentMatches) el.tournamentMatches.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
  }
}

function renderTournamentMatches() {
  if (!el.tournamentMatches) return;
  if (!state.tournamentMatches.length) {
    el.tournamentMatches.innerHTML = `<div class="mini-card"><p class="muted">Ingen fullførte kamper i denne turneringen ennå.</p></div>`;
    return;
  }
  el.tournamentMatches.innerHTML = state.tournamentMatches.map((match) => `
    <button type="button" class="match-result-card" data-match-detail="${Number(match.id)}">
      <span class="match-result-context">${esc(match.group_name || match.bracket_label || "Turnering")}${match.round_label ? ` · ${esc(match.round_label)}` : ""}</span>
      <span class="match-result-main"><strong>${esc(match.player_a_name)}</strong><b>${Number(match.player_a_legs || 0)}–${Number(match.player_b_legs || 0)}</b><strong>${esc(match.player_b_name)}</strong></span>
      <span class="match-result-stats"><span>3DA ${match.player_a_average !== null ? Number(match.player_a_average).toFixed(2) : "—"}</span><span>${match.player_b_average !== null ? Number(match.player_b_average).toFixed(2) : "—"}</span></span>
    </button>`).join("");
  bindMatchDetailLinks(el.tournamentMatches);
}

async function loadSeasonStandings() {
  if (!el.seasonStandings) return;
  const season = state.seasons.find((item) => item.is_active) || state.seasons[0] || null;
  if (!season) {
    el.seasonStandings.innerHTML = `<div class="mini-card"><p class="muted">Ingen sesong er opprettet ennå.</p></div>`;
    return;
  }
  try {
    const data = await api(`/seasons/${Number(season.id)}/standings`);
    const elo = data.season?.ranking_method === "elo";
    el.seasonStandings.innerHTML = `
      <div class="season-table-heading"><div><strong>${esc(data.season?.name || season.name)}</strong><p class="tie-break-note">Ved likt: leg differanse → 3DA → innbyrdes.</p></div><span class="pill">${data.season?.status === "active" ? "Aktiv" : "Sesong"}</span></div>
      <div class="table-scroll"><table class="portal-table season-table"><thead><tr><th>#</th><th>Spiller</th><th>K</th><th>V</th><th>Leg</th><th>3DA</th><th>${elo ? "ELO" : "P"}</th></tr></thead>
      <tbody>${(data.items || []).map((row) => `<tr data-player-profile="${Number(row.id)}"><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.matches_played)}</td><td>${Number(row.wins)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td>${Number(row.three_dart_average || 0) > 0 ? Number(row.three_dart_average).toFixed(2) : "—"}</td><td><strong>${elo ? Number(row.elo_rating).toFixed(1) : Number(row.points).toLocaleString("nb-NO", { maximumFractionDigits: 2 })}</strong></td></tr>`).join("")}</tbody></table></div>`;
    bindProfileLinks(el.seasonStandings);
  } catch (error) {
    el.seasonStandings.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
  }
}

async function loadMyMatches() {
  if (!el.myMatchList) return;
  if (!portalToken()) {
    el.myMatchList.innerHTML = `<div class="mini-card"><p class="muted">Logg inn for å se dine egne tidligere kamper.</p></div>`;
    return;
  }
  try {
    const me = await api("/auth/me", { auth: true });
    const playerId = Number(me.user?.player?.id || 0);
    if (!playerId) {
      el.myMatchList.innerHTML = `<div class="mini-card"><p class="muted">Kontoen din er ikke koblet til en spillerprofil ennå.</p></div>`;
      return;
    }
    const data = await api(`/players/${playerId}/matches`);
    const matches = data.items || [];
    if (!matches.length) {
      el.myMatchList.innerHTML = `<div class="mini-card"><p class="muted">Ingen fullførte kamper registrert ennå.</p></div>`;
      return;
    }
    const first = matches.slice(0, 5);
    el.myMatchList.innerHTML = `${renderHistoryRows(first)}${matches.length > 5 ? `<button type="button" class="ghost my-matches-all">Vis alle ${matches.length} kamper</button>` : ""}`;
    bindMatchDetailLinks(el.myMatchList);
    el.myMatchList.querySelector(".my-matches-all")?.addEventListener("click", (event) => {
      el.myMatchList.innerHTML = renderHistoryRows(matches);
      bindMatchDetailLinks(el.myMatchList);
      event.currentTarget?.remove();
    });
  } catch (error) {
    el.myMatchList.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
  }
}

function bindMatchDetailLinks(root) {
  root?.querySelectorAll("[data-match-detail]").forEach((item) => item.addEventListener("click", () => {
    openMatchDetail(Number(item.dataset.matchDetail)).catch(() => {});
  }));
}

function statValue(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function renderPlayerMatchStat(label, a, b, digits = 0, suffix = "") {
  return `<div class="match-stat-row"><strong>${statValue(a, digits)}${a === null || a === undefined ? "" : suffix}</strong><span>${esc(label)}</span><strong>${statValue(b, digits)}${b === null || b === undefined ? "" : suffix}</strong></div>`;
}

async function openMatchDetail(matchId) {
  if (!el.matchDetailDialog || !el.matchDetailContent) return;
  el.matchDetailContent.innerHTML = `<p class="muted">Henter kamp …</p>`;
  if (typeof el.matchDetailDialog.showModal === "function") el.matchDetailDialog.showModal();
  else el.matchDetailDialog.setAttribute("open", "");

  try {
    const data = await api(`/matches/${matchId}/detail`);
    const match = data.match || {};
    const a = data.player_a_stats || {};
    const b = data.player_b_stats || {};
    const visits = data.visits || [];
    const visitsByLeg = new Map();
    visits.forEach((visit) => {
      const key = Number(visit.leg_number || 0);
      if (!visitsByLeg.has(key)) visitsByLeg.set(key, []);
      visitsByLeg.get(key).push(visit);
    });
    const aLegs = Number(a.legs_won || 0);
    const bLegs = Number(b.legs_won || 0);

    el.matchDetailContent.innerHTML = `
      <div class="match-detail-head">
        <div><p class="eyebrow">${esc(match.tournament_name)}</p><h2>${esc(match.player_a_name)} ${aLegs}–${bLegs} ${esc(match.player_b_name)}</h2><p class="muted">${esc(match.round_label || match.bracket_label || "Kamp")}${match.board_number ? ` · Skive ${Number(match.board_number)}` : ""} · ${esc(formatDateTime(match.finished_at || match.starts_at))}</p></div>
        <button type="button" class="ghost match-detail-close">Lukk</button>
      </div>
      <div class="match-stat-board">
        <div class="match-stat-names"><strong>${esc(match.player_a_name)}</strong><span></span><strong>${esc(match.player_b_name)}</strong></div>
        ${renderPlayerMatchStat("3DA", a.average, b.average, 2)}
        ${renderPlayerMatchStat("First 9", a.first_nine_average, b.first_nine_average, 2)}
        ${renderPlayerMatchStat("Checkout", a.checkout_percentage, b.checkout_percentage, 1, "%")}
        ${renderPlayerMatchStat("Høy checkout", a.highest_checkout, b.highest_checkout)}
        ${renderPlayerMatchStat("100+", a.score_100_plus, b.score_100_plus)}
        ${renderPlayerMatchStat("140+", a.score_140_plus, b.score_140_plus)}
        ${renderPlayerMatchStat("180", a.score_180, b.score_180)}
      </div>
      <div class="match-legs">
        <h3>Legs</h3>
        ${(data.legs || []).length ? data.legs.map((leg) => {
          const winner = Number(leg.winner_player_id) === Number(match.player_a_id) ? match.player_a_name : Number(leg.winner_player_id) === Number(match.player_b_id) ? match.player_b_name : "—";
          const legVisits = visitsByLeg.get(Number(leg.leg_number)) || [];
          return `<article class="leg-card">
            <button type="button" class="leg-card-toggle" data-leg="${Number(leg.leg_number)}"><span><strong>Leg ${Number(leg.leg_number)}</strong><small>${esc(winner)} vant</small></span><span>${Number(leg.player_a_average || 0) > 0 ? Number(leg.player_a_average).toFixed(2) : "—"} · ${Number(leg.player_b_average || 0) > 0 ? Number(leg.player_b_average).toFixed(2) : "—"}</span></button>
            <div class="leg-visits hidden" data-leg-visits="${Number(leg.leg_number)}">${legVisits.length ? legVisits.map((visit) => `<div class="visit-row"><span>${Number(visit.player_id) === Number(match.player_a_id) ? esc(match.player_a_name) : esc(match.player_b_name)}</span><strong>${Number(visit.score)}</strong><span>${visit.is_bust ? "Bust" : `${Number(visit.remaining_after)} igjen`}</span></div>`).join("") : `<p class="muted">Ingen kastdetaljer lagret for dette leget.</p>`}</div>
          </article>`;
        }).join("") : `<p class="muted">Ingen leg-detaljer lagret for denne kampen.</p>`}
      </div>`;

    el.matchDetailContent.querySelector(".match-detail-close")?.addEventListener("click", () => el.matchDetailDialog.close?.());
    el.matchDetailContent.querySelectorAll(".leg-card-toggle").forEach((button) => button.addEventListener("click", () => {
      el.matchDetailContent.querySelector(`[data-leg-visits="${button.dataset.leg}"]`)?.classList.toggle("hidden");
    }));
  } catch (error) {
    el.matchDetailContent.innerHTML = `<div class="match-detail-head"><div><h2>Kunne ikke hente kampen</h2><p class="muted">${esc(error.message)}</p></div><button type="button" class="ghost match-detail-close">Lukk</button></div>`;
    el.matchDetailContent.querySelector(".match-detail-close")?.addEventListener("click", () => el.matchDetailDialog.close?.());
  }
}

function bindTournamentTabs() {
  document.querySelectorAll("[data-tournament-view]").forEach((button) => {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      const target = button.dataset.tournamentView;
      document.querySelectorAll("[data-tournament-view]").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll("[data-tournament-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.tournamentPanel !== target));
    });
  });
}

el.tableTournamentSelect?.addEventListener("change", loadTournamentTable);
el.clubSelect?.addEventListener("change", () => {
  state.clubId = Number(el.clubSelect.value || 0);
  setTimeout(() => loadPortalContent().catch(() => {}), 0);
});
el.refreshButton?.addEventListener("click", () => setTimeout(() => loadPortalContent().catch(() => {}), 0));
el.matchDetailDialog?.addEventListener("click", (event) => {
  if (event.target === el.matchDetailDialog) el.matchDetailDialog.close?.();
});

loadPortalContent().catch((error) => {
  if (el.playerDirectory) el.playerDirectory.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
});
