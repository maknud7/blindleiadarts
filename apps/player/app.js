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
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `Request failed with ${response.status}`);
  }
  return payload.data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "Ikke satt";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function registrationLabel(status) {
  return {
    registered: "Påmeldt",
    waitlisted: "Venteliste",
    checked_in: "Checket inn",
    withdrawn: "Meldt av",
    no_show: "Ikke møtt",
    eliminated: "Ute",
  }[status] || status || "Ukjent";
}

function setStatus(message, tone = "info") {
  const item = document.createElement("div");
  item.className = "mini-card";
  item.innerHTML = `<strong>${tone === "error" ? "Feil" : tone === "success" ? "OK" : "Info"}</strong><p class="muted">${escapeHtml(message)}</p>`;
  elements.statusArea.prepend(item);
  while (elements.statusArea.children.length > 4) {
    elements.statusArea.removeChild(elements.statusArea.lastChild);
  }
}

function persistToken(token) {
  state.token = token;
  if (token) localStorage.setItem("bd:token", token);
  else localStorage.removeItem("bd:token");
}

async function loadClubs() {
  const data = await api("/clubs");
  state.clubs = data.items || [];
  if (!state.selectedClubId && state.clubs[0]) {
    state.selectedClubId = Number(state.clubs[0].id);
  }
  localStorage.setItem("bd:playerClubId", String(state.selectedClubId || ""));
  elements.clubSelect.innerHTML = state.clubs
    .map((club) => `<option value="${club.id}" ${Number(club.id) === state.selectedClubId ? "selected" : ""}>${escapeHtml(club.name)}</option>`)
    .join("");
}

async function loadClubTournaments() {
  if (!state.selectedClubId) return;
  const data = await api(`/clubs/${state.selectedClubId}/registration-tournaments`);
  state.tournaments = data.items || [];
  renderTournaments();
}

async function loadCurrentUser() {
  if (!state.token) {
    state.me = null;
    state.dashboard = null;
    renderAuth();
    renderDashboard();
    renderTournaments();
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
    renderTournaments();
  } catch (error) {
    persistToken("");
    state.me = null;
    state.dashboard = null;
    renderAuth();
    renderDashboard();
    renderTournaments();
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
      <strong>${escapeHtml(state.me.display_name)}</strong>
      <p class="muted">${escapeHtml(state.me.username)}</p>
      <p class="muted">${escapeHtml(state.me.player?.display_name || "Ingen spillerprofil koblet")}</p>
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
          <div class="pill">${escapeHtml(ranking.ranking_type)}</div>
          <p class="muted">${escapeHtml(ranking.scope_type)} · ${escapeHtml(ranking.points)} poeng${ranking.position ? ` · plass ${escapeHtml(ranking.position)}` : ""}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen ranking snapshots ennå.</p></div>`;

  elements.registrationList.innerHTML = registrations.length
    ? registrations.map((registration) => {
        const status = String(registration.status || "");
        const tournamentId = Number(registration.tournament_id);
        const actions = status === "registered"
          ? `<div class="stack"><button data-checkin="${tournamentId}">Check inn på arena</button><button class="ghost" data-withdraw="${tournamentId}">Meld av</button></div>`
          : status === "waitlisted"
            ? `<div class="stack"><p class="muted">Du står på venteliste og får automatisk plass når noen melder av.</p><button class="ghost" data-withdraw="${tournamentId}">Fjern meg fra ventelisten</button></div>`
            : status === "checked_in"
              ? `<p class="muted">Du er klar for board-tildeling når arrangøren kaller opp kampen.</p>`
              : "";
        return `
          <div class="list-item">
            <div class="section-head">
              <div>
                <strong>${escapeHtml(registration.tournament_name)}</strong>
                <p class="muted">${escapeHtml(registration.club_name)} · ${escapeHtml(registration.tournament_status)}</p>
              </div>
              <span class="pill">${escapeHtml(registrationLabel(status))}</span>
            </div>
            ${actions}
          </div>
        `;
      }).join("")
    : `<div class="mini-card"><p class="muted">Ingen påmeldinger ennå.</p></div>`;
}

function renderTournaments() {
  applyBranding();
  const registrations = Array.isArray(state.dashboard?.registrations) ? state.dashboard.registrations : [];
  const registrationsByTournament = new Map(
    registrations.map((registration) => [Number(registration.tournament_id), registration])
  );

  elements.tournamentList.innerHTML = state.tournaments.length
    ? state.tournaments.map((tournament) => {
        const registration = registrationsByTournament.get(Number(tournament.id)) || null;
        const status = String(registration?.status || "");
        const activeRegistration = ["registered", "waitlisted", "checked_in"].includes(status);
        const registrationState = String(tournament.registration_state || "open");
        const maxPlayers = tournament.max_players ? Number(tournament.max_players) : null;
        const confirmed = Number(tournament.registration_count || 0);
        const waitlist = Number(tournament.waitlist_count || 0);
        const capacity = maxPlayers ? `${confirmed}/${maxPlayers} plasser` : `${confirmed} påmeldte`;
        const waitlistText = waitlist > 0 ? ` · ${waitlist} på venteliste` : "";
        const windowText = registrationState === "not_open"
          ? `Påmelding åpner ${formatDate(tournament.registration_opens_at)}`
          : registrationState === "closed"
            ? "Påmelding stengt"
            : tournament.registration_closes_at
              ? `Påmelding til ${formatDate(tournament.registration_closes_at)}`
              : "Påmelding åpen";

        let action = "";
        if (status === "checked_in") {
          action = `<p class="muted">Du er påmeldt og checket inn på arena.</p>`;
        } else if (status === "waitlisted") {
          action = `<div class="stack"><p class="muted">Du står på venteliste.</p><button class="ghost" data-withdraw="${tournament.id}">Fjern meg fra ventelisten</button></div>`;
        } else if (status === "registered") {
          action = `<div class="stack"><p class="muted">Du har plass i turneringen.</p><button data-checkin="${tournament.id}">Check inn på arena</button><button class="ghost" data-withdraw="${tournament.id}">Meld av</button></div>`;
        } else if (!state.me) {
          action = `<button disabled>Logg inn for å melde deg på</button>`;
        } else if (registrationState === "open") {
          action = `<button data-register="${tournament.id}">Meld meg på</button>`;
        } else {
          action = `<button disabled>${registrationState === "not_open" ? "Påmelding ikke åpnet" : "Påmelding stengt"}</button>`;
        }

        return `
          <div class="list-item">
            <div class="section-head">
              <div>
                <strong>${escapeHtml(tournament.name)}</strong>
                <p class="muted">${escapeHtml(formatDate(tournament.start_at))} · ${escapeHtml(windowText)}</p>
              </div>
              <span class="pill">${escapeHtml(capacity + waitlistText)}</span>
            </div>
            ${activeRegistration ? `<p class="muted">Status: ${escapeHtml(registrationLabel(status))}</p>` : ""}
            ${action}
          </div>
        `;
      }).join("")
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
    const data = await api(`/tournaments/${tournamentId}/register`, {
      method: "POST",
      auth: true,
    });
    const status = data.registration?.status;
    setStatus(status === "waitlisted" ? "Turneringen er full. Du står nå på venteliste." : "Du er meldt på turneringen.", "success");
    await Promise.all([loadClubTournaments(), loadCurrentUser()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function withdrawFromTournament(tournamentId) {
  try {
    await api(`/tournaments/${tournamentId}/register`, {
      method: "DELETE",
      auth: true,
    });
    setStatus("Du er meldt av turneringen.", "success");
    await Promise.all([loadClubTournaments(), loadCurrentUser()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function checkInForTournament(tournamentId) {
  try {
    await api(`/tournaments/${tournamentId}/check-in`, {
      method: "POST",
      auth: true,
    });
    setStatus("Du er nå checket inn på arenaen.", "success");
    await Promise.all([loadClubTournaments(), loadCurrentUser()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleRegistrationClick(event) {
  const registerButton = event.target.closest("[data-register]");
  if (registerButton) {
    await registerForTournament(Number(registerButton.dataset.register));
    return;
  }
  const withdrawButton = event.target.closest("[data-withdraw]");
  if (withdrawButton) {
    await withdrawFromTournament(Number(withdrawButton.dataset.withdraw));
    return;
  }
  const checkInButton = event.target.closest("[data-checkin]");
  if (checkInButton) {
    await checkInForTournament(Number(checkInButton.dataset.checkin));
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

  elements.tournamentList.addEventListener("click", handleRegistrationClick);
  elements.registrationList.addEventListener("click", handleRegistrationClick);
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
