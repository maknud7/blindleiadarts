const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:screenClubId") || 0),
  dashboard: null,
};

const elements = {
  clubSelect: document.getElementById("clubSelect"),
  refreshButton: document.getElementById("refreshButton"),
  kioskGrid: document.getElementById("kioskGrid"),
  tournamentList: document.getElementById("tournamentList"),
  recentMatches: document.getElementById("recentMatches"),
};

async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`);
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }

  return payload.data;
}

async function loadClubs() {
  const data = await api("/clubs");
  state.clubs = data.items;

  if (!state.selectedClubId && state.clubs[0]) {
    state.selectedClubId = Number(state.clubs[0].id);
  }

  elements.clubSelect.innerHTML = state.clubs
    .map((club) => `<option value="${club.id}" ${Number(club.id) === state.selectedClubId ? "selected" : ""}>${club.name}</option>`)
    .join("");
}

async function loadDashboard() {
  if (!state.selectedClubId) {
    return;
  }

  state.dashboard = await api(`/clubs/${state.selectedClubId}/dashboard`);
  render();
}

function render() {
  const dashboard = state.dashboard;

  if (!dashboard) {
    return;
  }

  elements.kioskGrid.innerHTML = dashboard.kiosks.length
    ? dashboard.kiosks.map((kiosk) => `
        <div class="tile">
          <strong>${kiosk.name}</strong>
          <p class="muted">Board ${kiosk.board_number}</p>
          <p class="muted">${kiosk.code}</p>
        </div>
      `).join("")
    : `<div class="tile"><p class="muted">Ingen kiosker ennå.</p></div>`;

  elements.tournamentList.innerHTML = dashboard.tournaments.length
    ? dashboard.tournaments.map((tournament) => `
        <div class="list-item">
          <strong>${tournament.name}</strong>
          <p class="muted">${tournament.registration_count} påmeldte · ${tournament.match_count} kamper</p>
        </div>
      `).join("")
    : `<div class="list-item"><p class="muted">Ingen turneringer ennå.</p></div>`;

  elements.recentMatches.innerHTML = dashboard.recent_matches.length
    ? dashboard.recent_matches.map((match) => `
        <div class="list-item">
          <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
          <p class="muted">${match.tournament_name} · ${match.status}</p>
        </div>
      `).join("")
    : `<div class="list-item"><p class="muted">Ingen kamper ennå.</p></div>`;
}

function bindEvents() {
  elements.clubSelect.addEventListener("change", async (event) => {
    state.selectedClubId = Number(event.target.value);
    localStorage.setItem("bd:screenClubId", String(state.selectedClubId));
    await loadDashboard();
  });

  elements.refreshButton.addEventListener("click", () => loadDashboard());
}

async function bootstrap() {
  bindEvents();
  await loadClubs();
  await loadDashboard();
  window.setInterval(() => loadDashboard().catch(() => undefined), 10000);
}

bootstrap();
