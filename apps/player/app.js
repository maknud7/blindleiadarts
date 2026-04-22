const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:playerClubId") || 0),
  tournaments: [],
  me: null,
  dashboard: null,
  token: localStorage.getItem("bd:token") || "",
};

const elements = {
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  clubIntro: document.getElementById("clubIntro"),
  clubSelect: document.getElementById("clubSelect"),
  refreshButton: document.getElementById("refreshButton"),
  loginForm: document.getElementById("loginForm"),
  loginUsername: document.getElementById("loginUsername"),
  loginPassword: document.getElementById("loginPassword"),
  authSummary: document.getElementById("authSummary"),
  logoutButton: document.getElementById("logoutButton"),
  statusArea: document.getElementById("statusArea"),
  statsGrid: document.getElementById("statsGrid"),
  rankingList: document.getElementById("rankingList"),
  registrationList: document.getElementById("registrationList"),
  tournamentList: document.getElementById("tournamentList"),
};

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (auth && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }

  return payload.data;
}

function setStatus(message, tone = "info") {
  const item = document.createElement("div");
  item.className = "mini-card";
  item.innerHTML = `<strong>${tone === "error" ? "Feil" : tone === "success" ? "OK" : "Info"}</strong><p class="muted">${message}</p>`;
  elements.statusArea.prepend(item);

  while (elements.statusArea.children.length > 4) {
    elements.statusArea.removeChild(elements.statusArea.lastChild);
  }
}

function persistToken(token) {
  state.token = token;

  if (token) {
    localStorage.setItem("bd:token", token);
  } else {
    localStorage.removeItem("bd:token");
  }
}

async function loadClubs() {
  const data = await api("/clubs");
  state.clubs = data.items;

  if (!state.selectedClubId && state.clubs[0]) {
    state.selectedClubId = Number(state.clubs[0].id);
  }

  localStorage.setItem("bd:playerClubId", String(state.selectedClubId || ""));
  elements.clubSelect.innerHTML = state.clubs
    .map((club) => `<option value="${club.id}" ${Number(club.id) === state.selectedClubId ? "selected" : ""}>${club.name}</option>`)
    .join("");
}

async function loadClubTournaments() {
  if (!state.selectedClubId) {
    return;
  }

  const data = await api(`/clubs/${state.selectedClubId}/tournaments`);
  state.tournaments = data.items;
  renderTournaments();
}

async function loadCurrentUser() {
  if (!state.token) {
    state.me = null;
    state.dashboard = null;
    renderAuth();
    renderDashboard();
    return;
  }

  try {
    const [meData, dashboardData] = await Promise.all([
      api("/auth/me", { auth: true }),
      api("/me/dashboard", { auth: true }),
    ]);

    state.me = meData.user;
    state.dashboard = dashboardData.dashboard;
    renderAuth();
    renderDashboard();
  } catch (error) {
    persistToken("");
    state.me = null;
    state.dashboard = null;
    renderAuth();
    renderDashboard();
    setStatus(error.message, "error");
  }
}

function applyBranding() {
  const club = state.clubs.find((entry) => Number(entry.id) === state.selectedClubId) || null;
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandTitle.textContent = club?.name ? `${club.name} spillerportal` : "Din dartdag på mobilen";
  elements.clubIntro.textContent = club?.name
    ? `Meld deg på turneringer, se egne tall og følg klubbaktivitet i ${club.name}.`
    : "Velg klubb og logg inn for å bruke spillerportalen.";
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

function renderAuth() {
  if (state.me) {
    elements.authSummary.classList.remove("hidden");
    elements.logoutButton.classList.remove("hidden");
    elements.authSummary.innerHTML = `
      <strong>${state.me.display_name}</strong>
      <p class="muted">${state.me.username}</p>
      <p class="muted">${state.me.player?.display_name || "Ingen spillerprofil koblet"}</p>
    `;
  } else {
    elements.authSummary.classList.add("hidden");
    elements.logoutButton.classList.add("hidden");
    elements.authSummary.innerHTML = "";
  }
}

function renderDashboard() {
  if (!state.me || !state.dashboard) {
    elements.statsGrid.innerHTML = `
      <div class="stat-card"><small>Kamper</small><strong>-</strong></div>
      <div class="stat-card"><small>Snitt per visit</small><strong>-</strong></div>
      <div class="stat-card"><small>Legs vunnet</small><strong>-</strong></div>
      <div class="stat-card"><small>Visits logget</small><strong>-</strong></div>
    `;
    elements.rankingList.innerHTML = `<div class="mini-card"><p class="muted">Logg inn for å se ranking og personlige tall.</p></div>`;
    elements.registrationList.innerHTML = `<div class="mini-card"><p class="muted">Logg inn for å se egne påmeldinger.</p></div>`;
    return;
  }

  const stats = state.dashboard.stats || {};
  const rankings = stats.rankings || [];
  const registrations = state.dashboard.registrations || [];

  elements.statsGrid.innerHTML = `
    <div class="stat-card"><small>Kamper</small><strong>${stats.matches_played || 0}</strong></div>
    <div class="stat-card"><small>Seire</small><strong>${stats.matches_won || 0}</strong></div>
    <div class="stat-card"><small>Legs vunnet</small><strong>${stats.legs_won || 0}</strong></div>
    <div class="stat-card"><small>Snitt per visit</small><strong>${Number(stats.average_visit_score || 0).toFixed(2)}</strong></div>
  `;

  elements.rankingList.innerHTML = rankings.length
    ? rankings.map((ranking) => `
        <div class="list-item">
          <div class="pill">${ranking.ranking_type}</div>
          <p class="muted">${ranking.scope_type} · ${ranking.points} poeng${ranking.position ? ` · plass ${ranking.position}` : ""}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen ranking snapshots ennå.</p></div>`;

  elements.registrationList.innerHTML = registrations.length
    ? registrations.map((registration) => `
        <div class="list-item">
          <strong>${registration.tournament_name}</strong>
          <p class="muted">${registration.club_name} · ${registration.status}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen påmeldinger ennå.</p></div>`;
}

function renderTournaments() {
  applyBranding();

  elements.tournamentList.innerHTML = state.tournaments.length
    ? state.tournaments.map((tournament) => `
        <div class="list-item">
          <div class="section-head">
            <div>
              <strong>${tournament.name}</strong>
              <p class="muted">${tournament.provider_system} · ${tournament.status}</p>
            </div>
            <span class="pill">${tournament.registration_count} påmeldte</span>
          </div>
          <button data-register="${tournament.id}" ${state.me ? "" : "disabled"}>Meld meg på</button>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen turneringer tilgjengelig akkurat nå.</p></div>`;
}

async function handleLogin(event) {
  event.preventDefault();

  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: {
        username: elements.loginUsername.value,
        password: elements.loginPassword.value,
      },
    });

    persistToken(data.access_token);
    await loadCurrentUser();
    setStatus("Innlogging lykkes.", "success");
    elements.loginForm.reset();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function registerForTournament(tournamentId) {
  try {
    await api(`/tournaments/${tournamentId}/register`, {
      method: "POST",
      auth: true,
    });

    setStatus("Du er meldt på turneringen.", "success");
    await Promise.all([loadClubTournaments(), loadCurrentUser()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindEvents() {
  elements.clubSelect.addEventListener("change", async (event) => {
    state.selectedClubId = Number(event.target.value);
    localStorage.setItem("bd:playerClubId", String(state.selectedClubId));
    await loadClubTournaments();
  });

  elements.refreshButton.addEventListener("click", async () => {
    await Promise.all([loadClubs(), loadClubTournaments(), loadCurrentUser()]);
    setStatus("Spillerdata oppdatert.", "success");
  });

  elements.loginForm.addEventListener("submit", handleLogin);

  elements.logoutButton.addEventListener("click", () => {
    persistToken("");
    state.me = null;
    state.dashboard = null;
    renderAuth();
    renderDashboard();
    renderTournaments();
    setStatus("Logget ut.", "success");
  });

  elements.tournamentList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-register]");

    if (!button) {
      return;
    }

    await registerForTournament(Number(button.dataset.register));
  });
}

async function bootstrap() {
  bindEvents();

  try {
    await loadClubs();
    await Promise.all([loadClubTournaments(), loadCurrentUser()]);
    setStatus("Spillerportalen er klar.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

bootstrap();
