const API_ROOT = "../api/v1";

const state = {
  clubId: Number(localStorage.getItem("bd:playerClubId") || 0),
  tournaments: [],
  players: [],
  elo: [],
  summaries: [],
};

const el = {
  clubSelect: document.getElementById("clubSelect"),
  refreshButton: document.getElementById("refreshButton"),
  eloTable: document.getElementById("eloTable"),
  tableTournamentSelect: document.getElementById("tableTournamentSelect"),
  groupTables: document.getElementById("groupTables"),
  playerDirectory: document.getElementById("playerDirectory"),
  playerProfile: document.getElementById("playerProfile"),
  summaryList: document.getElementById("summaryList"),
};

async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store" });
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

function summaryText(value) {
  return esc(value).replace(/\r?\n/g, "<br>");
}

function hasRecordedStats(player) {
  return Number(player.matches_played || 0) > 0
    || Number(player.baseline_played || 0) > 0
    || Number(player.score_180 || 0) > 0
    || Number(player.highest_checkout || 0) > 0
    || Number(player.recorded_average || 0) > 0;
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

  const [players, elo, summaries, tournaments] = await Promise.all([
    api(`/clubs/${clubId}/player-directory`),
    api(`/clubs/${clubId}/elo`),
    api(`/clubs/${clubId}/summaries`),
    api(`/clubs/${clubId}/registration-tournaments`),
  ]);

  state.players = (players.items || []).filter(hasRecordedStats);
  state.elo = (elo.items || []).filter(hasRecordedStats);
  state.summaries = summaries.items || [];
  state.tournaments = tournaments.items || [];
  renderElo();
  renderPlayers();
  renderSummaries();
  renderTournamentPicker();
  await loadTournamentTable();
}

function renderElo() {
  if (!state.elo.length) {
    el.eloTable.innerHTML = `<div class="mini-card"><p class="muted">Ingen registrert statistikk ennå.</p></div>`;
    return;
  }
  el.eloTable.innerHTML = `
    <div class="table-scroll">
      <table class="portal-table">
        <thead><tr><th>#</th><th>Spiller</th><th>ELO</th><th>Kamper</th><th>Seire</th></tr></thead>
        <tbody>${state.elo.map((row, index) => `
          <tr data-player-profile="${Number(row.id)}">
            <td>${index + 1}</td>
            <td><strong>${esc(row.display_name)}</strong>${row.nickname ? `<small>${esc(row.nickname)}</small>` : ""}</td>
            <td>${Number(row.elo_rating || 1000).toFixed(1)}</td>
            <td>${Number(row.baseline_played ?? row.matches_played ?? 0)}</td>
            <td>${Number(row.matches_won || 0)}</td>
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
      <span class="player-card-meta">ELO ${Number(player.elo_rating || 1000).toFixed(1)} · ${Number(player.matches_played || player.baseline_played || 0)} kamper</span>
    </button>`).join("");
  bindProfileLinks(el.playerDirectory);
}

function bindProfileLinks(root) {
  root.querySelectorAll("[data-player-profile]").forEach((item) => item.addEventListener("click", () => {
    loadPlayerProfile(Number(item.dataset.playerProfile)).catch((error) => renderProfileError(error.message));
  }));
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
      <div class="stat-card"><small>Kamper</small><strong>${Number(stats.matches_played || 0)}</strong></div>
      <div class="stat-card"><small>Seire</small><strong>${Number(stats.matches_won || 0)}</strong></div>
      <div class="stat-card"><small>Seiersprosent</small><strong>${Number(stats.win_percentage || 0).toFixed(1)}%</strong></div>
      <div class="stat-card"><small>Snitt</small><strong>${Number(stats.recorded_average || stats.visit_average || 0).toFixed(2)}</strong></div>
      <div class="stat-card"><small>Høy checkout</small><strong>${Number(stats.highest_checkout || 0)}</strong></div>
      <div class="stat-card"><small>Checkout %</small><strong>${stats.checkout_percentage === null || stats.checkout_percentage === undefined ? "—" : `${Number(stats.checkout_percentage).toFixed(1)}%`}</strong></div>
      <div class="stat-card"><small>180</small><strong>${Number(stats.visits_180 || 0)}</strong></div>
      <div class="stat-card"><small>140+</small><strong>${Number(stats.visits_140_plus || 0)}</strong></div>
      <div class="stat-card"><small>100+</small><strong>${Number(stats.visits_100_plus || 0)}</strong></div>
    </div>
    <div class="profile-section">
      <h3>Siste kamper</h3>
      ${recent.length ? recent.map((match) => {
        const opponent = Number(match.player_a_id) === playerId ? match.player_b_name : match.player_a_name;
        const label = match.result === "win" ? "Seier" : match.result === "draw" ? "Uavgjort" : "Tap";
        return `<div class="history-row"><div><strong>${esc(label)} mot ${esc(opponent)}</strong><small>${esc(match.tournament_name)}${match.round_label ? ` · ${esc(match.round_label)}` : ""}</small></div><span>${esc(formatDate(match.finished_at || match.start_at))}</span></div>`;
      }).join("") : `<p class="muted">Ingen fullførte kamper registrert.</p>`}
    </div>
    <div class="profile-section">
      <h3>ELO-historikk</h3>
      ${history.length ? history.slice(0, 8).map((entry) => `<div class="history-row"><div><strong>${Number(entry.rating).toFixed(1)}</strong><small>${esc(entry.tournament_name || entry.scope_type)}</small></div><span>${esc(formatDate(entry.calculated_at))}</span></div>`).join("") : `<p class="muted">Ingen ELO-historikk registrert ennå.</p>`}
    </div>`;

  el.playerProfile.querySelector(".profile-close")?.addEventListener("click", () => el.playerProfile.classList.add("hidden"));
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
  const eligible = state.tournaments.filter((tournament) => Number(tournament.registration_count || 0) > 0 || tournament.group_drawn_at);
  el.tableTournamentSelect.innerHTML = eligible.length
    ? eligible.map((tournament) => `<option value="${Number(tournament.id)}">${esc(tournament.name)} · ${esc(formatDate(tournament.start_at))}</option>`).join("")
    : `<option value="">Ingen turneringer med deltakere</option>`;
}

async function loadTournamentTable() {
  const tournamentId = Number(el.tableTournamentSelect.value || 0);
  if (!tournamentId) {
    el.groupTables.innerHTML = `<div class="mini-card"><p class="muted">Ingen gruppetabell å vise ennå.</p></div>`;
    return;
  }
  el.groupTables.innerHTML = `<p class="muted">Henter tabell …</p>`;
  try {
    const data = await api(`/tournaments/${tournamentId}/tables`);
    const groups = data.groups || [];
    el.groupTables.innerHTML = groups.map((group) => `
      <article class="table-card">
        <h3>${esc(group.name)}</h3>
        <div class="table-scroll"><table class="portal-table compact-table">
          <thead><tr><th>#</th><th>Spiller</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg</th><th>P</th></tr></thead>
          <tbody>${(group.rows || []).map((row) => `<tr data-player-profile="${Number(row.player_id)}"><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td><strong>${Number(row.points)}</strong></td></tr>`).join("")}</tbody>
        </table></div>
      </article>`).join("");
    bindProfileLinks(el.groupTables);
  } catch (error) {
    el.groupTables.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
  }
}

el.tableTournamentSelect?.addEventListener("change", loadTournamentTable);
el.clubSelect?.addEventListener("change", () => {
  state.clubId = Number(el.clubSelect.value || 0);
  setTimeout(() => loadPortalContent().catch(() => {}), 0);
});
el.refreshButton?.addEventListener("click", () => setTimeout(() => loadPortalContent().catch(() => {}), 0));

loadPortalContent().catch((error) => {
  if (el.playerDirectory) el.playerDirectory.innerHTML = `<div class="mini-card"><p class="muted">${esc(error.message)}</p></div>`;
});
