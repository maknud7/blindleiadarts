const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:screenClubId") || 0),
  dashboard: null,
  matchCalls: [],
  liveSource: null,
  pollHandle: null,
};

const elements = {
  clubSelect: document.getElementById("clubSelect"),
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
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

  const [dashboardData, matchCallData] = await Promise.all([
    api(`/clubs/${state.selectedClubId}/dashboard`),
    api(`/clubs/${state.selectedClubId}/match-calls`),
  ]);

  state.dashboard = dashboardData;
  state.matchCalls = matchCallData.items;
  render();
}

function closeLiveUpdates() {
  if (state.liveSource) {
    state.liveSource.close();
    state.liveSource = null;
  }

  if (state.pollHandle) {
    window.clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

function startLiveUpdates() {
  closeLiveUpdates();

  if (!state.selectedClubId || typeof window.EventSource !== "function") {
    state.pollHandle = window.setInterval(() => loadDashboard().catch(() => undefined), 5000);
    return;
  }

  const source = new EventSource(`${API_ROOT}/clubs/${state.selectedClubId}/live`);
  state.liveSource = source;

  source.addEventListener("snapshot", (event) => {
    const payload = JSON.parse(event.data);
    state.dashboard = payload.dashboard || null;
    state.matchCalls = payload.match_calls || [];
    render();
  });

  source.onerror = () => {
    closeLiveUpdates();
    state.pollHandle = window.setInterval(() => loadDashboard().catch(() => undefined), 5000);
  };
}

function render() {
  const dashboard = state.dashboard;

  if (!dashboard) {
    return;
  }

  applyClubBranding(dashboard.club);

  elements.kioskGrid.innerHTML = dashboard.kiosks.length
    ? dashboard.kiosks.map((kiosk) => `
        <div class="tile">
          <strong>${kiosk.name}</strong>
          <p class="muted">Board ${kiosk.board_number}</p>
          <p class="muted">${kiosk.sponsor_label || kiosk.code}</p>
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

  const liveMatches = state.matchCalls.length ? state.matchCalls : dashboard.recent_matches;

  elements.recentMatches.innerHTML = liveMatches.length
    ? liveMatches.map((match) => `
        <div class="list-item">
          <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
          <p class="muted">${match.tournament_name} · ${match.status}${match.board_number ? ` · Board ${match.board_number}` : ""}</p>
        </div>
      `).join("")
    : `<div class="list-item"><p class="muted">Ingen kamper ennå.</p></div>`;
}

function applyClubBranding(club) {
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandTitle.textContent = club?.name
    ? `Live oversikt for ${club.name}`
    : "Live oversikt for klubb og boards";
  elements.brandFallback.textContent = initials || "KL";

  if (club?.logo_url) {
    elements.brandLogo.src = club.logo_url;
    elements.brandLogo.alt = `${club.name} logo`;
    elements.brandLogo.classList.remove("hidden");
    elements.brandFallback.classList.add("hidden");
  } else {
    elements.brandLogo.removeAttribute("src");
    elements.brandLogo.classList.add("hidden");
    elements.brandFallback.classList.remove("hidden");
  }
}

function bindEvents() {
  elements.clubSelect.addEventListener("change", async (event) => {
    state.selectedClubId = Number(event.target.value);
    localStorage.setItem("bd:screenClubId", String(state.selectedClubId));
    await loadDashboard();
    startLiveUpdates();
  });

  elements.refreshButton.addEventListener("click", () => loadDashboard());
}

async function bootstrap() {
  bindEvents();
  await loadClubs();
  await loadDashboard();
  startLiveUpdates();
}

bootstrap();
