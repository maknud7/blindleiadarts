const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:selectedClubId") || 0),
  clubDashboard: null,
  tournaments: [],
  me: null,
  memberDashboard: null,
  token: localStorage.getItem("bd:token") || "",
};

const elements = {
  clubSelect: document.getElementById("clubSelect"),
  refreshClubButton: document.getElementById("refreshClubButton"),
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  loginForm: document.getElementById("loginForm"),
  loginUsername: document.getElementById("loginUsername"),
  loginPassword: document.getElementById("loginPassword"),
  logoutButton: document.getElementById("logoutButton"),
  authSummary: document.getElementById("authSummary"),
  statusArea: document.getElementById("statusArea"),
  clubIntro: document.getElementById("clubIntro"),
  heroMetrics: document.getElementById("heroMetrics"),
  memberDashboard: document.getElementById("memberDashboard"),
  tournamentCards: document.getElementById("tournamentCards"),
  kioskList: document.getElementById("kioskList"),
  recentMatches: document.getElementById("recentMatches"),
  adminSection: document.getElementById("adminSection"),
  clubForm: document.getElementById("clubForm"),
  playerForm: document.getElementById("playerForm"),
  kioskForm: document.getElementById("kioskForm"),
  tournamentForm: document.getElementById("tournamentForm"),
  matchForm: document.getElementById("matchForm"),
  matchTournamentId: document.getElementById("matchTournamentId"),
  matchPlayerA: document.getElementById("matchPlayerA"),
  matchPlayerB: document.getElementById("matchPlayerB"),
  matchKioskId: document.getElementById("matchKioskId"),
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
    const message = payload?.error?.message || `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}

function setStatus(message, tone = "info") {
  const item = document.createElement("div");
  item.className = "mini-card";
  item.innerHTML = `<strong>${tone === "error" ? "Feil" : tone === "success" ? "OK" : "Info"}</strong><p class="muted">${message}</p>`;
  elements.statusArea.prepend(item);

  while (elements.statusArea.children.length > 5) {
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

  localStorage.setItem("bd:selectedClubId", String(state.selectedClubId || ""));
  renderClubSelect();
}

async function loadClubContext() {
  if (!state.selectedClubId) {
    return;
  }

  const [dashboardData, tournamentsData] = await Promise.all([
    api(`/clubs/${state.selectedClubId}/dashboard`),
    api(`/clubs/${state.selectedClubId}/tournaments`),
  ]);

  state.clubDashboard = dashboardData;
  state.tournaments = tournamentsData.items;
  renderClub();
}

async function loadCurrentUser() {
  if (!state.token) {
    state.me = null;
    state.memberDashboard = null;
    renderAuth();
    renderMemberDashboard();
    return;
  }

  try {
    const [meData, dashboardData] = await Promise.all([
      api("/auth/me", { auth: true }),
      api("/me/dashboard", { auth: true }),
    ]);

    state.me = meData.user;
    state.memberDashboard = dashboardData.dashboard;
    renderAuth();
    renderMemberDashboard();
  } catch (error) {
    persistToken("");
    state.me = null;
    state.memberDashboard = null;
    renderAuth();
    renderMemberDashboard();
    setStatus(error.message, "error");
  }
}

function renderClubSelect() {
  elements.clubSelect.innerHTML = state.clubs
    .map((club) => `<option value="${club.id}" ${Number(club.id) === state.selectedClubId ? "selected" : ""}>${club.name}</option>`)
    .join("");
}

function renderClub() {
  const dashboard = state.clubDashboard;

  if (!dashboard) {
    return;
  }

  applyClubBranding(dashboard.club);
  elements.clubIntro.textContent = `${dashboard.club.name} er lastet inn. Portal, kioskadmin og turneringsstyring er alltid klubbspesifikk.`;
  elements.heroMetrics.innerHTML = `
    <div class="metric"><small>Spillere</small><strong>${dashboard.players.length}</strong></div>
    <div class="metric"><small>Kiosker</small><strong>${dashboard.kiosks.length}</strong></div>
    <div class="metric"><small>Turneringer</small><strong>${dashboard.tournaments.length}</strong></div>
  `;

  elements.kioskList.innerHTML = dashboard.kiosks.length
    ? dashboard.kiosks.map((kiosk) => `
        <div class="list-item">
          <div class="row">
            <strong>${kiosk.name}</strong>
            <span class="muted">Board ${kiosk.board_number}</span>
          </div>
          <div class="pill-row">
            <span class="pill">${kiosk.code}</span>
            ${kiosk.sponsor_label ? `<span class="pill">${kiosk.sponsor_label}</span>` : ""}
            <span class="pill">${formatScoringMode(kiosk.scoring_mode)}</span>
          </div>
          <form class="stack" data-kiosk-settings="${kiosk.id}">
            <select name="scoring_mode">
              <option value="manual" ${kiosk.scoring_mode === "manual" ? "selected" : ""}>Manuell scoring</option>
              <option value="scolia" ${kiosk.scoring_mode === "scolia" ? "selected" : ""}>Scolia-eventer</option>
            </select>
            <button type="submit" class="ghost">Lagre kioskinnstillinger</button>
          </form>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen kiosker opprettet ennå.</p></div>`;

  elements.recentMatches.innerHTML = dashboard.recent_matches.length
    ? dashboard.recent_matches.map((match) => `
        <div class="list-item">
          <div class="row"><strong>${match.player_a_name} vs ${match.player_b_name}</strong><span class="muted">${match.status}</span></div>
          <p class="muted">${match.tournament_name}${match.board_number ? ` · Board ${match.board_number}` : ""}${match.winner_name ? ` · Vinner: ${match.winner_name}` : ""}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen kamper registrert ennå.</p></div>`;

  elements.tournamentCards.innerHTML = state.tournaments.length
    ? state.tournaments.map((tournament) => `
        <div class="list-item">
          <div class="row">
            <div>
              <strong>${tournament.name}</strong>
              <p class="muted">${tournament.provider_system} · ${tournament.status}</p>
            </div>
            <button data-register="${tournament.id}" ${state.me ? "" : "disabled"}>Meld på</button>
          </div>
          <div class="pill-row">
            <span class="pill">${tournament.registration_count} påmeldte</span>
            <span class="pill">${tournament.match_count} kamper</span>
            ${tournament.start_at ? `<span class="pill">${new Date(tournament.start_at).toLocaleString("no-NO")}</span>` : ""}
          </div>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen turneringer opprettet ennå.</p></div>`;

  populateAdminSelects();
}

function applyClubBranding(club) {
  const initials = (club?.name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  elements.brandTitle.textContent = club?.name || "Klubbportal";
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
      <p class="muted">${state.me.username} · ${state.me.role}</p>
      <p class="muted">${state.me.player?.display_name || "Ingen spillerprofil koblet"}</p>
    `;
  } else {
    elements.authSummary.classList.add("hidden");
    elements.logoutButton.classList.add("hidden");
    elements.authSummary.innerHTML = "";
  }

  const isAdmin = state.me?.role === "admin";
  elements.adminSection.classList.toggle("hidden", !isAdmin);
}

function renderMemberDashboard() {
  if (!state.me || !state.memberDashboard) {
    elements.memberDashboard.innerHTML = `
      <div class="mini-card">
        <strong>Logg inn for medlemsside</strong>
        <p class="muted">Når du er logget inn får du egne påmeldinger, spillerstatistikk og etter hvert full historikk.</p>
      </div>
    `;
    return;
  }

  const stats = state.memberDashboard.stats || {};
  const registrations = state.memberDashboard.registrations || [];

  elements.memberDashboard.innerHTML = `
    <div class="pill-row">
      <span class="pill">${stats.matches_played || 0} kamper</span>
      <span class="pill">${stats.matches_won || 0} seire</span>
      <span class="pill">${stats.legs_won || 0} legs vunnet</span>
      <span class="pill">${Number(stats.average_visit_score || 0).toFixed(2)} avg. visit</span>
    </div>
    <div class="stack">
      ${registrations.length
        ? registrations.map((entry) => `
            <div class="list-item">
              <strong>${entry.tournament_name}</strong>
              <p class="muted">${entry.club_name} · ${entry.status}</p>
            </div>
          `).join("")
        : `<div class="mini-card"><p class="muted">Ingen påmeldinger ennå.</p></div>`}
    </div>
  `;
}

function populateAdminSelects() {
  const players = state.clubDashboard?.players || [];
  const kiosks = state.clubDashboard?.kiosks || [];

  elements.matchTournamentId.innerHTML = state.tournaments
    .map((tournament) => `<option value="${tournament.id}">${tournament.name}</option>`)
    .join("");

  const playerOptions = [`<option value="">Velg spiller</option>`]
    .concat(players.map((player) => `<option value="${player.id}">${player.display_name}</option>`))
    .join("");

  elements.matchPlayerA.innerHTML = playerOptions;
  elements.matchPlayerB.innerHTML = playerOptions;
  elements.matchKioskId.innerHTML = [`<option value="">Ingen kiosk ennå</option>`]
    .concat(kiosks.map((kiosk) => `<option value="${kiosk.id}">${kiosk.name} (${kiosk.code})</option>`))
    .join("");
}

function formatScoringMode(mode) {
  return mode === "scolia" ? "Scolia" : "Manuell";
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

async function handleTournamentRegister(tournamentId) {
  try {
    await api(`/tournaments/${tournamentId}/register`, {
      method: "POST",
      auth: true,
    });

    setStatus("Spiller ble meldt på turneringen.", "success");
    await Promise.all([loadClubContext(), loadCurrentUser()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function collectFormValues(form) {
  const formData = new FormData(form);
  const payload = {};

  for (const [key, value] of formData.entries()) {
    if (value === "") {
      continue;
    }

    payload[key] = value;
  }

  return payload;
}

async function submitAdminForm(form, endpoint, successMessage) {
  try {
    const body = collectFormValues(form);
    await api(endpoint, {
      method: "POST",
      body,
      auth: true,
    });

    form.reset();
    setStatus(successMessage, "success");
    await loadClubs();
    await loadClubContext();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindEvents() {
  elements.clubSelect.addEventListener("change", async (event) => {
    state.selectedClubId = Number(event.target.value);
    localStorage.setItem("bd:selectedClubId", String(state.selectedClubId));
    await loadClubContext();
  });

  elements.refreshClubButton.addEventListener("click", async () => {
    await Promise.all([loadClubs(), loadClubContext(), loadCurrentUser()]);
    setStatus("Klubbdata oppdatert.", "success");
  });

  elements.loginForm.addEventListener("submit", handleLogin);

  elements.logoutButton.addEventListener("click", async () => {
    persistToken("");
    state.me = null;
    state.memberDashboard = null;
    renderAuth();
    renderMemberDashboard();
    setStatus("Logget ut lokalt i portalen.", "success");
  });

  elements.tournamentCards.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-register]");
    if (!button) {
      return;
    }

    await handleTournamentRegister(Number(button.dataset.register));
  });

  elements.kioskList.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-kiosk-settings]");

    if (!form) {
      return;
    }

    event.preventDefault();

    try {
      const body = collectFormValues(form);
      const kioskId = Number(form.dataset.kioskSettings);

      await api(`/clubs/${state.selectedClubId}/kiosks/${kioskId}`, {
        method: "PATCH",
        body,
        auth: true,
      });

      setStatus("Kioskinnstillinger lagret.", "success");
      await loadClubContext();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.clubForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.clubForm, "/clubs", "Klubb opprettet.");
  });

  elements.playerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.playerForm, `/clubs/${state.selectedClubId}/players`, "Spiller opprettet.");
  });

  elements.kioskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.kioskForm, `/clubs/${state.selectedClubId}/kiosks`, "Kiosk opprettet.");
  });

  elements.tournamentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.tournamentForm, `/clubs/${state.selectedClubId}/tournaments`, "Turnering opprettet.");
  });

  elements.matchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = collectFormValues(elements.matchForm);

    try {
      await api(`/tournaments/${body.tournament_id}/matches`, {
        method: "POST",
        body,
        auth: true,
      });

      elements.matchForm.reset();
      setStatus("Kamp opprettet.", "success");
      await loadClubContext();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

async function bootstrap() {
  bindEvents();

  try {
    await loadClubs();
    await Promise.all([loadClubContext(), loadCurrentUser()]);
    setStatus("Portal v1 er klar.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

bootstrap();
