const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:selectedClubId") || 0),
  clubDashboard: null,
  matchCalls: [],
  tournaments: [],
  me: null,
  token: localStorage.getItem("bd:token") || "",
  activeView: localStorage.getItem("bd:adminView") || "overview",
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
  navPanel: document.getElementById("navPanel"),
  adminNav: document.getElementById("adminNav"),
  statusArea: document.getElementById("statusArea"),
  clubIntro: document.getElementById("clubIntro"),
  heroMetrics: document.getElementById("heroMetrics"),
  tournamentList: document.getElementById("tournamentList"),
  kioskList: document.getElementById("kioskList"),
  boardCallList: document.getElementById("boardCallList"),
  playerList: document.getElementById("playerList"),
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

async function loadMatchCalls() {
  if (!state.selectedClubId) {
    state.matchCalls = [];
    return;
  }

  const data = await api(`/clubs/${state.selectedClubId}/match-calls`);
  state.matchCalls = data.items;
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
  await loadMatchCalls();
  renderClub();
}

async function loadCurrentUser() {
  if (!state.token) {
    state.me = null;
    renderAuth();
    return;
  }

  try {
    const meData = await api("/auth/me", { auth: true });
    state.me = meData.user;
    renderAuth();
  } catch (error) {
    persistToken("");
    state.me = null;
    renderAuth();
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
  elements.clubIntro.textContent = `${dashboard.club.name} er lastet inn. Denne flaten er rendyrket for administrasjon av klubb, kiosk og turnering.`;
  elements.heroMetrics.innerHTML = `
    <div class="metric"><small>Spillere</small><strong>${dashboard.players.length}</strong></div>
    <div class="metric"><small>Kiosker</small><strong>${dashboard.kiosks.length}</strong></div>
    <div class="metric"><small>Turneringer</small><strong>${dashboard.tournaments.length}</strong></div>
  `;

  elements.playerList.innerHTML = dashboard.players.length
    ? dashboard.players.map((player) => `
        <div class="list-item">
          <div class="row">
            <strong>${player.display_name}</strong>
            <span class="pill">${player.role || "player"}</span>
          </div>
          <p class="muted">${player.username || "Ingen bruker"}${player.user_account_id ? ` · konto #${player.user_account_id}` : ""}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen spillere opprettet ennå.</p></div>`;

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
            <span class="pill">${Number(kiosk.is_paired) === 1 ? "Paret" : "Ikke paret"}</span>
            ${kiosk.paired_device_name ? `<span class="pill">${kiosk.paired_device_name}</span>` : ""}
          </div>
          <form class="stack" data-kiosk-settings="${kiosk.id}">
            <select name="scoring_mode">
              <option value="manual" ${kiosk.scoring_mode === "manual" ? "selected" : ""}>Manuell scoring</option>
              <option value="scolia" ${kiosk.scoring_mode === "scolia" ? "selected" : ""}>Scolia-eventer</option>
            </select>
            <button type="submit" class="ghost">Lagre kioskinnstillinger</button>
          </form>
          <button type="button" class="ghost" data-reset-kiosk-pairing="${kiosk.id}">Nullstill paring</button>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen kiosker opprettet ennå.</p></div>`;

  elements.tournamentList.innerHTML = state.tournaments.length
    ? state.tournaments.map((tournament) => `
        <div class="list-item">
          <div class="row">
            <strong>${tournament.name}</strong>
            <span class="pill">${tournament.status}</span>
          </div>
          <div class="pill-row">
            <span class="pill">${tournament.provider_system}</span>
            <span class="pill">${tournament.registration_count} påmeldte</span>
            <span class="pill">${tournament.match_count} kamper</span>
            ${tournament.start_at ? `<span class="pill">${new Date(tournament.start_at).toLocaleString("no-NO")}</span>` : ""}
          </div>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen turneringer opprettet ennå.</p></div>`;

  elements.recentMatches.innerHTML = dashboard.recent_matches.length
    ? dashboard.recent_matches.map((match) => `
        <div class="list-item">
          <div class="row">
            <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
            <span class="pill">${match.status}</span>
          </div>
          <p class="muted">${match.tournament_name}${match.board_number ? ` · Board ${match.board_number}` : ""}${match.winner_name ? ` · Vinner: ${match.winner_name}` : ""}</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen kamper registrert ennå.</p></div>`;

  elements.boardCallList.innerHTML = state.matchCalls.length
    ? state.matchCalls.map((match) => `
        <div class="list-item">
          <div class="row">
            <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
            <span class="pill">${match.status}</span>
          </div>
          <p class="muted">${match.tournament_name}${match.round_label ? ` · ${match.round_label}` : ""}${match.bracket_label ? ` · ${match.bracket_label}` : ""}</p>
          <div class="pill-row">
            ${match.board_number ? `<span class="pill">Board ${match.board_number}</span>` : `<span class="pill">Ikke tildelt</span>`}
            ${match.kiosk_code ? `<span class="pill">${match.kiosk_code}</span>` : ""}
          </div>
          <form class="stack" data-assign-match="${match.id}">
            <select name="kiosk_id">
              <option value="">Velg board</option>
              ${(dashboard.kiosks || []).map((kiosk) => `
                <option value="${kiosk.id}" ${Number(kiosk.id) === Number(match.kiosk_id) ? "selected" : ""}>
                  Board ${kiosk.board_number} · ${kiosk.name}
                </option>
              `).join("")}
            </select>
            <button type="submit" class="ghost">Tildel til board</button>
          </form>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen ventende eller aktive kamper å tildele akkurat nå.</p></div>`;

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

  elements.brandTitle.textContent = club?.name || "Klubbadministrasjon";
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
      <p class="muted">${state.me.is_super_admin ? "Har tilgang til alle klubber" : "Har klubbspesifikk adminrolle"}</p>
    `;
  } else {
    elements.authSummary.classList.add("hidden");
    elements.logoutButton.classList.add("hidden");
    elements.authSummary.innerHTML = "";
  }

  const isAdmin = ["super_admin", "club_admin"].includes(state.me?.role || "");
  elements.adminSection.classList.toggle("hidden", !isAdmin);
  elements.navPanel.classList.toggle("hidden", !isAdmin);

  const canCreateClubs = state.me?.role === "super_admin";
  elements.clubForm.querySelectorAll("input, button").forEach((element) => {
    element.disabled = !canCreateClubs;
  });

  if (!isAdmin && state.activeView !== "overview") {
    setActiveView("overview");
  }

  renderActiveView();
}

function setActiveView(view) {
  state.activeView = view;
  localStorage.setItem("bd:adminView", view);
  renderActiveView();
}

function renderActiveView() {
  const isAdmin = ["super_admin", "club_admin"].includes(state.me?.role || "");
  const activeView = isAdmin ? state.activeView : "overview";

  document.querySelectorAll("[data-view-button]").forEach((button) => {
    const view = button.dataset.viewButton;
    const shouldShow = view === "overview" || isAdmin;
    button.classList.toggle("hidden", !shouldShow);
    button.classList.toggle("active", view === activeView);
  });

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== activeView);
    panel.classList.toggle("active", panel.dataset.viewPanel === activeView);
  });
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
  elements.matchKioskId.innerHTML = [`<option value="">Ingen kiosk</option>`]
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

  elements.logoutButton.addEventListener("click", () => {
    persistToken("");
    state.me = null;
    renderAuth();
    setStatus("Logget ut lokalt i admin.", "success");
  });

  elements.adminNav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view-button]");

    if (!button) {
      return;
    }

    setActiveView(button.dataset.viewButton);
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

  elements.kioskList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-reset-kiosk-pairing]");

    if (!button) {
      return;
    }

    try {
      await api(`/clubs/${state.selectedClubId}/kiosks/${Number(button.dataset.resetKioskPairing)}/reset-pairing`, {
        method: "POST",
        auth: true,
      });

      setStatus("Kioskparing nullstilt.", "success");
      await loadClubContext();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.boardCallList.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-assign-match]");

    if (!form) {
      return;
    }

    event.preventDefault();
    const kioskId = Number(new FormData(form).get("kiosk_id") || 0);

    if (kioskId <= 0) {
      setStatus("Velg et board før du tildeler kampen.", "error");
      return;
    }

    try {
      await api(`/matches/${Number(form.dataset.assignMatch)}/assign-kiosk`, {
        method: "POST",
        body: { kiosk_id: kioskId },
        auth: true,
      });

      setStatus("Kamp tildelt til board.", "success");
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
  renderActiveView();

  try {
    await loadClubs();
    await Promise.all([loadClubContext(), loadCurrentUser()]);
    setStatus("Admin Studio er klar.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

bootstrap();
