const API_ROOT = "../api/v1";

const state = {
  clubs: [],
  selectedClubId: Number(localStorage.getItem("bd:selectedClubId") || 0),
  clubDashboard: null,
  matchCalls: [],
  pairingRequests: [],
  screenDevices: [],
  tournaments: [],
  me: null,
  token: localStorage.getItem("bd:token") || "",
  activeView: localStorage.getItem("bd:adminView") || "overview",
  highlightedPairingCode: "",
  liveSource: null,
  reconnectHandle: null,
  realtimeConfig: null,
  isEditing: false,
  systemStatus: null,
  tournamentOps: null,
  selectedTournamentOpsId: Number(localStorage.getItem("bd:opsTournamentId") || 0),
};

const elements = {
  authGate: document.getElementById("authGate"),
  adminApp: document.getElementById("adminApp"),
  clubSelect: document.getElementById("clubSelect"),
  refreshClubButton: document.getElementById("refreshClubButton"),
  loginBrandLogo: document.getElementById("loginBrandLogo"),
  loginBrandFallback: document.getElementById("loginBrandFallback"),
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
  authStatusArea: document.getElementById("authStatusArea"),
  clubIntro: document.getElementById("clubIntro"),
  pageTitle: document.getElementById("pageTitle"),
  pageDescription: document.getElementById("pageDescription"),
  refreshStatusButton: document.getElementById("refreshStatusButton"),
  heroMetrics: document.getElementById("heroMetrics"),
  tournamentList: document.getElementById("tournamentList"),
  kioskList: document.getElementById("kioskList"),
  pairingRequestList: document.getElementById("pairingRequestList"),
  kioskPairingCode: document.getElementById("kioskPairingCode"),
  kioskPairingCodeHint: document.getElementById("kioskPairingCodeHint"),
  boardCallList: document.getElementById("boardCallList"),
  playerList: document.getElementById("playerList"),
  recentMatches: document.getElementById("recentMatches"),
  screenDeviceList: document.getElementById("screenDeviceList"),
  serviceStatusGrid: document.getElementById("serviceStatusGrid"),
  clubRuntimeStatus: document.getElementById("clubRuntimeStatus"),
  clubForm: document.getElementById("clubForm"),
  playerForm: document.getElementById("playerForm"),
  kioskForm: document.getElementById("kioskForm"),
  screenDeviceForm: document.getElementById("screenDeviceForm"),
  tournamentForm: document.getElementById("tournamentForm"),
  opsTournamentSelect: document.getElementById("opsTournamentSelect"),
  tournamentOpsSummary: document.getElementById("tournamentOpsSummary"),
  tournamentBoardGrid: document.getElementById("tournamentBoardGrid"),
  tournamentRegistrationSummary: document.getElementById("tournamentRegistrationSummary"),
  registeredPlayerList: document.getElementById("registeredPlayerList"),
  registrationRosterList: document.getElementById("registrationRosterList"),
  saveTournamentBoardsButton: document.getElementById("saveTournamentBoardsButton"),
  autoAssignMatchesButton: document.getElementById("autoAssignMatchesButton"),
  tournamentQueueList: document.getElementById("tournamentQueueList"),
  matchForm: document.getElementById("matchForm"),
  matchTournamentId: document.getElementById("matchTournamentId"),
  matchTournamentHint: document.getElementById("matchTournamentHint"),
  matchPlayerA: document.getElementById("matchPlayerA"),
  matchPlayerB: document.getElementById("matchPlayerB"),
  matchKioskId: document.getElementById("matchKioskId"),
};

const viewMeta = {
  overview: {
    title: "Oversikt",
    description: "Se driftsstatus, siste aktivitet og nøkkeltall for valgt klubb.",
  },
  status: {
    title: "Status og helse",
    description: "Sjekk API, database, realtime-lag og valgt klubbs operative status før turneringskveld.",
  },
  boards: {
    title: "Boards og kiosker",
    description: "Administrer pairing, boards, screen-koder og board calls uten at siden hopper rundt.",
  },
  tournaments: {
    title: "Turneringer",
    description: "Opprett og juster klubber og turneringer i et eget arbeidsområde.",
  },
  players: {
    title: "Spillere",
    description: "Hold spillerregister og brukerkontoer adskilt fra resten av driftsbildet.",
  },
  matches: {
    title: "Kamper",
    description: "Opprett kamper manuelt og knytt dem til riktig turnering og board.",
  },
  help: {
    title: "Hjelp og flyt",
    description: "Steg-for-steg for pairing, board calls og turneringskveld.",
  },
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

async function loadRealtimeConfig() {
  if (state.realtimeConfig !== null) {
    return state.realtimeConfig;
  }

  try {
    state.realtimeConfig = await api("/realtime/config");
  } catch {
    state.realtimeConfig = {
      enabled: false,
      transport: "sse",
      websocket_url: "",
    };
  }

  return state.realtimeConfig;
}

function setStatus(message, tone = "info") {
  const createItem = () => {
    const item = document.createElement("div");
    item.className = "mini-card";
    item.innerHTML = `<strong>${tone === "error" ? "Feil" : tone === "success" ? "OK" : "Info"}</strong><p class="muted">${message}</p>`;
    return item;
  };

  elements.statusArea.prepend(createItem());

  while (elements.statusArea.children.length > 5) {
    elements.statusArea.removeChild(elements.statusArea.lastChild);
  }

  if (!hasAdminAccess()) {
    elements.authStatusArea.prepend(createItem());

    while (elements.authStatusArea.children.length > 3) {
      elements.authStatusArea.removeChild(elements.authStatusArea.lastChild);
    }
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

function hasAdminAccess() {
  return ["super_admin", "club_admin"].includes(state.me?.role || "");
}

async function loadMatchCalls() {
  if (!state.selectedClubId) {
    state.matchCalls = [];
    return;
  }

  const data = await api(`/clubs/${state.selectedClubId}/match-calls`);
  state.matchCalls = data.items;
}

async function loadPairingRequests() {
  if (!state.selectedClubId || !state.token) {
    state.pairingRequests = [];
    return;
  }

  const data = await api(`/clubs/${state.selectedClubId}/kiosk-pairing-requests`, { auth: true });
  state.pairingRequests = data.items;
}

async function loadScreenDevices() {
  if (!state.selectedClubId || !state.token) {
    state.screenDevices = [];
    return;
  }

  const data = await api(`/clubs/${state.selectedClubId}/screen-devices`, { auth: true });
  state.screenDevices = data.items;
}

async function loadSystemStatus() {
  if (!state.token || !hasAdminAccess()) {
    state.systemStatus = null;
    return;
  }

  const query = state.selectedClubId ? `?club_id=${state.selectedClubId}` : "";
  state.systemStatus = await api(`/system/status${query}`, { auth: true });
}

async function loadTournamentOps() {
  if (!state.token || !hasAdminAccess()) {
    state.tournamentOps = null;
    return;
  }

  if (!state.selectedTournamentOpsId && state.tournaments[0]) {
    state.selectedTournamentOpsId = Number(state.tournaments[0].id);
  }

  if (!state.selectedTournamentOpsId) {
    state.tournamentOps = null;
    renderTournamentOps();
    return;
  }

  localStorage.setItem("bd:opsTournamentId", String(state.selectedTournamentOpsId));
  state.tournamentOps = await api(`/tournaments/${state.selectedTournamentOpsId}/board-assignments`, { auth: true });
}

async function loadClubContext() {
  if (!state.selectedClubId || !hasAdminAccess()) {
    return;
  }

  const [dashboardData, tournamentsData] = await Promise.all([
    api(`/clubs/${state.selectedClubId}/dashboard`),
    api(`/clubs/${state.selectedClubId}/tournaments`),
  ]);

  state.clubDashboard = dashboardData;
  state.tournaments = tournamentsData.items;
  if (!state.tournaments.some((tournament) => Number(tournament.id) === state.selectedTournamentOpsId)) {
    state.selectedTournamentOpsId = state.tournaments[0] ? Number(state.tournaments[0].id) : 0;
  }
  await loadMatchCalls();
  await loadPairingRequests();
  await loadScreenDevices();
  await loadSystemStatus();
  await loadTournamentOps();
  renderClub();
}

function closeLiveUpdates() {
  if (state.liveSource) {
    state.liveSource.close();
    state.liveSource = null;
  }

  if (state.reconnectHandle) {
    window.clearTimeout(state.reconnectHandle);
    state.reconnectHandle = null;
  }
}

function applyLivePayload(payload) {
  state.clubDashboard = payload.dashboard || null;
  state.matchCalls = payload.match_calls || [];

  if (state.activeView === "overview" && !state.isEditing) {
    renderClub();
  }
}

function scheduleReconnect() {
  if (state.reconnectHandle || !state.selectedClubId) {
    return;
  }

  state.reconnectHandle = window.setTimeout(() => {
    state.reconnectHandle = null;
    startLiveUpdates().catch(() => undefined);
  }, 1000);
}

async function startLiveUpdates() {
  closeLiveUpdates();

  if (!state.selectedClubId || !hasAdminAccess() || state.activeView !== "overview") {
    return;
  }

  const realtime = await loadRealtimeConfig();

  if (realtime?.enabled && realtime.websocket_url) {
    const socket = new WebSocket(realtime.websocket_url);
    state.liveSource = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        channels: [`club:${state.selectedClubId}`],
      }));
    });

    socket.addEventListener("message", (event) => {
      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message?.type !== "event" || message?.event !== "snapshot") {
        return;
      }

      applyLivePayload(message.payload);
    });

    socket.addEventListener("close", () => {
      if (state.liveSource === socket) {
        state.liveSource = null;
      }

      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });

    return;
  }

  if (typeof window.EventSource === "function") {
    const source = new EventSource(`${API_ROOT}/clubs/${state.selectedClubId}/live`);
    state.liveSource = source;

    source.addEventListener("snapshot", (event) => {
      try {
        applyLivePayload(JSON.parse(event.data));
      } catch {
        // ignore malformed SSE payloads
      }
    });

    source.onerror = () => {
      closeLiveUpdates();
      scheduleReconnect();
    };
  }
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
  elements.kioskPairingCode.textContent = dashboard.club.kiosk_pairing_code || "---";
  elements.kioskPairingCodeHint.textContent = dashboard.club.kiosk_pairing_code
    ? `Bruk ${dashboard.club.kiosk_pairing_code} på /kiosk/ før nettbrettet kan pares mot et board i ${dashboard.club.name}.`
    : "Denne klubben mangler kioskkode ennå.";
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

  elements.pairingRequestList.innerHTML = state.pairingRequests.length
    ? state.pairingRequests.map((request) => `
        <div class="list-item ${request.request_code === state.highlightedPairingCode ? "is-highlighted" : ""}">
          <div class="row">
            <strong>${request.device_name || "Nettbrett"}</strong>
            <span class="pill">${request.request_code}</span>
          </div>
          <div class="pill-row">
            ${request.requested_at ? `<span class="pill">Opprettet ${new Date(request.requested_at).toLocaleTimeString("no-NO", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}
            ${request.expires_at ? `<span class="pill">Utløper ${new Date(request.expires_at).toLocaleTimeString("no-NO", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}
          </div>
          <form class="stack" data-approve-pairing="${request.request_code}">
            <select name="kiosk_id">
              <option value="">Velg board</option>
              ${(dashboard.kiosks || []).map((kiosk) => `
                <option value="${kiosk.id}">
                  Board ${kiosk.board_number} · ${kiosk.name}
                </option>
              `).join("")}
            </select>
            <button type="submit" class="ghost">Godkjenn pairing</button>
          </form>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen ventende nettbrett akkurat nå.</p></div>`;

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

  elements.screenDeviceList.innerHTML = state.screenDevices.length
    ? state.screenDevices.map((device) => `
        <div class="list-item">
          <div class="row">
            <strong>${device.label || "Venue Screen"}</strong>
            <span class="pill">${device.access_code}</span>
          </div>
          <div class="pill-row">
            <span class="pill">${Number(device.is_active) === 1 ? "Aktiv" : "Inaktiv"}</span>
            ${device.last_connected_at ? `<span class="pill">Sist brukt ${new Date(device.last_connected_at).toLocaleString("no-NO")}</span>` : `<span class="pill">Ikke brukt ennå</span>`}
          </div>
          <p class="muted">Aapne ../screen/ og tast inn denne koden pa oppstartsskjermen.</p>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen skjermkoder opprettet ennå.</p></div>`;

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
  renderSystemStatus();
  renderTournamentOps();
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
  elements.loginBrandFallback.textContent = initials || "BD";

  if (club?.logo_url) {
    elements.brandLogo.src = club.logo_url;
    elements.brandLogo.alt = `${club.name} logo`;
    elements.brandLogo.classList.remove("hidden");
    elements.brandFallback.classList.add("hidden");
    elements.loginBrandLogo.src = club.logo_url;
    elements.loginBrandLogo.alt = `${club.name} logo`;
    elements.loginBrandLogo.classList.remove("hidden");
    elements.loginBrandFallback.classList.add("hidden");
  } else {
    elements.brandLogo.removeAttribute("src");
    elements.brandLogo.classList.add("hidden");
    elements.brandFallback.classList.remove("hidden");
    elements.loginBrandLogo.removeAttribute("src");
    elements.loginBrandLogo.classList.add("hidden");
    elements.loginBrandFallback.classList.remove("hidden");
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

  const isAdmin = hasAdminAccess();
  elements.navPanel.classList.toggle("hidden", !isAdmin);
  elements.authGate.classList.toggle("hidden", isAdmin);
  elements.adminApp.classList.toggle("hidden", !isAdmin);

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
  const isAdmin = hasAdminAccess();
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

  const meta = viewMeta[activeView] || viewMeta.overview;
  elements.pageTitle.textContent = meta.title;
  elements.pageDescription.textContent = meta.description;

  if (isAdmin) {
    if (activeView === "overview") {
      startLiveUpdates().catch(() => undefined);
    } else {
      closeLiveUpdates();
    }
  }
}

function populateAdminSelects() {
  const players = state.clubDashboard?.players || [];
  const kiosks = state.clubDashboard?.kiosks || [];

  elements.matchTournamentId.innerHTML = state.tournaments
    .map((tournament) => `
      <option
        value="${tournament.id}"
        ${Number(tournament.id) === state.selectedTournamentOpsId ? "selected" : ""}
      >
        ${tournament.name}
      </option>
    `)
    .join("");

  const selectedTournamentId = Number(elements.matchTournamentId.value || state.selectedTournamentOpsId || 0);
  const tournamentDetail = Number(state.tournamentOps?.tournament?.id) === selectedTournamentId
    ? state.tournamentOps?.tournament
    : state.tournaments.find((tournament) => Number(tournament.id) === selectedTournamentId) || null;
  const registrations = Array.isArray(tournamentDetail?.registrations)
    ? tournamentDetail.registrations.filter((registration) => registration.status !== "withdrawn")
    : [];
  const registeredPlayerIds = registrations.map((registration) => Number(registration.player_id));
  const registeredPlayers = players.filter((player) => registeredPlayerIds.includes(Number(player.id)));

  const playerOptions = registeredPlayers.length
    ? [`<option value="">Velg spiller</option>`]
      .concat(registeredPlayers.map((player) => `<option value="${player.id}">${player.display_name}</option>`))
      .join("")
    : `<option value="">Ingen påmeldte spillere</option>`;

  elements.matchPlayerA.innerHTML = playerOptions;
  elements.matchPlayerB.innerHTML = playerOptions;
  elements.matchKioskId.innerHTML = [`<option value="">Ingen kiosk</option>`]
    .concat(kiosks.map((kiosk) => `<option value="${kiosk.id}">${kiosk.name} (${kiosk.code})</option>`))
    .join("");

  elements.opsTournamentSelect.innerHTML = state.tournaments.length
    ? state.tournaments.map((tournament) => `
        <option value="${tournament.id}" ${Number(tournament.id) === state.selectedTournamentOpsId ? "selected" : ""}>
          ${tournament.name}
        </option>
      `).join("")
    : `<option value="">Ingen turneringer</option>`;

  elements.matchTournamentHint.textContent = selectedTournamentId > 0
    ? registrations.length > 0
      ? `${registrations.length} spillere er påmeldt denne turneringen og kan brukes i kampopprettelse.`
      : "Ingen spillere er påmeldt denne turneringen ennå. Gå til Turneringer og meld på spillere først."
    : "Velg turnering først. Kun påmeldte spillere blir tilgjengelige.";

  const canCreateMatch = selectedTournamentId > 0 && registeredPlayers.length >= 2;
  elements.matchPlayerA.disabled = !canCreateMatch;
  elements.matchPlayerB.disabled = !canCreateMatch;
  elements.matchForm.querySelector('button[type="submit"]').disabled = !canCreateMatch;
}

function renderSystemStatus() {
  const status = state.systemStatus;

  if (!status) {
    elements.serviceStatusGrid.innerHTML = `<div class="mini-card"><p class="muted">Status lastes inn når du er logget inn som admin.</p></div>`;
    elements.clubRuntimeStatus.innerHTML = `<div class="mini-card"><p class="muted">Velg klubb for å se operativ status.</p></div>`;
    return;
  }

  elements.serviceStatusGrid.innerHTML = (status.services || []).map((service) => `
    <div class="service-card ${service.status || "info"}">
      <div class="row">
        <strong>${service.label}</strong>
        <span class="pill">${service.status}</span>
      </div>
      <p class="muted">${service.detail || ""}</p>
    </div>
  `).join("");

  const clubStatus = status.club;

  if (!clubStatus || !clubStatus.club) {
    elements.clubRuntimeStatus.innerHTML = `<div class="mini-card"><p class="muted">Ingen klubbstatus tilgjengelig ennå.</p></div>`;
    return;
  }

  const dashboard = clubStatus.dashboard || {};
  const activeTournament = clubStatus.active_screen_tournament;
  const screenDevices = clubStatus.screen_devices || [];
  elements.clubRuntimeStatus.innerHTML = `
    <div class="list-item">
      <div class="row">
        <strong>${clubStatus.club.name}</strong>
        <span class="pill">${status.environment}</span>
      </div>
      <div class="pill-row">
        <span class="pill">${(dashboard.players || []).length} spillere</span>
        <span class="pill">${(dashboard.kiosks || []).length} boards</span>
        <span class="pill">${(dashboard.tournaments || []).length} turneringer</span>
        <span class="pill">${(dashboard.recent_matches || []).length} siste kamper</span>
      </div>
    </div>
    <div class="list-item">
      <strong>Aktiv screen-turnering</strong>
      <p class="muted">${activeTournament ? `${activeTournament.name} (${activeTournament.status})` : "Ingen aktiv/ready turnering akkurat nå."}</p>
    </div>
    <div class="list-item">
      <strong>Pairing og screen</strong>
      <div class="pill-row">
        <span class="pill">${clubStatus.pending_pairing_requests || 0} ventende pairing requests</span>
        <span class="pill">${screenDevices.length} skjermenheter</span>
      </div>
    </div>
  `;
}

function renderTournamentOps() {
  const ops = state.tournamentOps;

  if (!ops || !ops.tournament) {
    elements.tournamentOpsSummary.innerHTML = `<p class="muted">Velg en turnering for å styre boards og auto-tildeling.</p>`;
    elements.tournamentBoardGrid.innerHTML = "";
    elements.tournamentQueueList.innerHTML = `<div class="mini-card"><p class="muted">Ingen turneringskø lastet ennå.</p></div>`;
    elements.tournamentRegistrationSummary.innerHTML = `<p class="muted">Velg en turnering for å se påmeldinger og tilgjengelige spillere.</p>`;
    elements.registeredPlayerList.innerHTML = `<div class="mini-card"><p class="muted">Ingen turnering valgt ennå.</p></div>`;
    elements.registrationRosterList.innerHTML = `<div class="mini-card"><p class="muted">Klubbens spillere vises her når en turnering er valgt.</p></div>`;
    return;
  }

  const registrations = Array.isArray(ops.tournament.registrations) ? ops.tournament.registrations : [];
  const activeRegistrations = registrations.filter((registration) => registration.status !== "withdrawn");
  const registeredIds = activeRegistrations.map((registration) => Number(registration.player_id));
  const availablePlayers = (state.clubDashboard?.players || [])
    .filter((player) => !registeredIds.includes(Number(player.id)))
    .sort((left, right) => left.display_name.localeCompare(right.display_name, "no-NO"));

  elements.tournamentOpsSummary.innerHTML = `
    <strong>${ops.tournament.name}</strong>
    <div class="pill-row">
      <span class="pill">${ops.tournament.status}</span>
      <span class="pill">${activeRegistrations.length} påmeldte</span>
      <span class="pill">${ops.queue?.pending_count ?? 0} pending</span>
      <span class="pill">${ops.queue?.assigned_count ?? 0} assigned</span>
      <span class="pill">${ops.queue?.in_progress_count ?? 0} i gang</span>
    </div>
  `;

  elements.tournamentRegistrationSummary.innerHTML = `
    <strong>${ops.tournament.name}</strong>
    <div class="pill-row">
      <span class="pill">${activeRegistrations.length} aktive påmeldinger</span>
      <span class="pill">${availablePlayers.length} tilgjengelige klubbspillere</span>
      <span class="pill">${registrations.filter((registration) => registration.status === "withdrawn").length} trukket</span>
    </div>
  `;

  elements.tournamentBoardGrid.innerHTML = (ops.boards || []).map((board) => `
    <label class="board-checkbox ${Number(board.is_available) === 1 ? "" : "is-busy"}">
      <input type="checkbox" value="${board.id}" ${Number(board.is_assigned_to_tournament) === 1 ? "checked" : ""}>
      <div class="stack">
        <strong>${board.name}</strong>
        <span class="muted">Board ${board.board_number}${board.sponsor_label ? ` · ${board.sponsor_label}` : ""}</span>
        <div class="pill-row">
          <span class="pill">${board.code}</span>
          <span class="pill">${Number(board.is_available) === 1 ? "Ledig" : "Opptatt"}</span>
        </div>
      </div>
    </label>
  `).join("");

  const queueItems = ops.queue?.items || [];
  elements.tournamentQueueList.innerHTML = queueItems.length
    ? queueItems.map((match) => `
        <div class="list-item">
          <div class="row">
            <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
            <span class="pill">${match.status}</span>
          </div>
          <p class="muted">${match.round_label || "Kamp"}${match.bracket_label ? ` · ${match.bracket_label}` : ""}</p>
          <div class="pill-row">
            <span class="pill">${match.players_available ? "Spillere ledige" : "Spillere opptatt"}</span>
            ${match.board_number ? `<span class="pill">Board ${match.board_number}</span>` : `<span class="pill">Ikke tildelt</span>`}
          </div>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen kamper i denne turneringen ennå.</p></div>`;

  elements.registeredPlayerList.innerHTML = activeRegistrations.length
    ? activeRegistrations.map((registration) => `
        <div class="list-item">
          <div class="row">
            <strong>${registration.display_name}</strong>
            <span class="pill">${registration.status}</span>
          </div>
          <div class="pill-row">
            ${registration.seed ? `<span class="pill">Seed ${registration.seed}</span>` : ""}
            ${registration.contact_email ? `<span class="pill">${registration.contact_email}</span>` : ""}
            ${registration.contact_phone ? `<span class="pill">${registration.contact_phone}</span>` : ""}
          </div>
          <div class="row actions-row">
            <span class="muted">Påmeldt i turneringen og klar for kampopprettelse.</span>
            <button type="button" class="ghost compact-link" data-remove-registration="${registration.player_id}">Fjern</button>
          </div>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Ingen spillere er påmeldt denne turneringen ennå.</p></div>`;

  elements.registrationRosterList.innerHTML = availablePlayers.length
    ? availablePlayers.map((player) => `
        <div class="list-item">
          <div class="row">
            <strong>${player.display_name}</strong>
            <span class="pill">${player.username || "Ingen konto"}</span>
          </div>
          <div class="pill-row">
            ${player.contact_email ? `<span class="pill">${player.contact_email}</span>` : ""}
            ${player.contact_phone ? `<span class="pill">${player.contact_phone}</span>` : ""}
          </div>
          <button type="button" class="ghost compact-link" data-add-registration="${player.id}">Meld på turneringen</button>
        </div>
      `).join("")
    : `<div class="mini-card"><p class="muted">Alle klubbens spillere er allerede påmeldt denne turneringen.</p></div>`;

  populateAdminSelects();
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
    await loadClubs();
    await loadClubContext();
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
    await Promise.all([loadClubs(), loadCurrentUser()]);
    await loadClubContext();
    setStatus("Klubbdata oppdatert.", "success");
  });

  elements.refreshStatusButton.addEventListener("click", async () => {
    try {
      await loadSystemStatus();
      renderSystemStatus();
      setStatus("Systemstatus oppdatert.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.loginForm.addEventListener("submit", handleLogin);

  elements.logoutButton.addEventListener("click", () => {
    closeLiveUpdates();
    persistToken("");
    state.me = null;
    state.clubDashboard = null;
    state.matchCalls = [];
    state.systemStatus = null;
    state.tournamentOps = null;
    renderAuth();
    setStatus("Logget ut lokalt i admin.", "success");
  });

  elements.adminApp.addEventListener("focusin", (event) => {
    if (event.target.matches("input, select, textarea")) {
      state.isEditing = true;
    }
  });

  elements.adminApp.addEventListener("focusout", () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      state.isEditing = Boolean(active && elements.adminApp.contains(active) && active.matches("input, select, textarea"));
    }, 0);
  });

  elements.adminNav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view-button]");

    if (!button) {
      return;
    }

    setActiveView(button.dataset.viewButton);
  });

  elements.opsTournamentSelect.addEventListener("change", async (event) => {
    state.selectedTournamentOpsId = Number(event.target.value || 0);
    localStorage.setItem("bd:opsTournamentId", String(state.selectedTournamentOpsId || ""));

    try {
      await loadTournamentOps();
      renderTournamentOps();
      populateAdminSelects();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.matchTournamentId.addEventListener("change", async (event) => {
    state.selectedTournamentOpsId = Number(event.target.value || 0);
    localStorage.setItem("bd:opsTournamentId", String(state.selectedTournamentOpsId || ""));

    try {
      await loadTournamentOps();
      renderTournamentOps();
      populateAdminSelects();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.saveTournamentBoardsButton.addEventListener("click", async () => {
    if (!state.selectedTournamentOpsId) {
      setStatus("Velg en turnering først.", "error");
      return;
    }

    const kioskIds = Array.from(elements.tournamentBoardGrid.querySelectorAll("input[type=\"checkbox\"]:checked"))
      .map((checkbox) => Number(checkbox.value))
      .filter((value) => value > 0);

    try {
      state.tournamentOps = await api(`/tournaments/${state.selectedTournamentOpsId}/board-assignments`, {
        method: "PUT",
        body: { kiosk_ids: kioskIds },
        auth: true,
      });
      renderTournamentOps();
      await loadSystemStatus();
      renderSystemStatus();
      setStatus("Boards lagret for turneringen.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.autoAssignMatchesButton.addEventListener("click", async () => {
    if (!state.selectedTournamentOpsId) {
      setStatus("Velg en turnering først.", "error");
      return;
    }

    try {
      const result = await api(`/tournaments/${state.selectedTournamentOpsId}/auto-assign`, {
        method: "POST",
        auth: true,
      });
      state.tournamentOps = result.overview || state.tournamentOps;
      renderTournamentOps();
      await Promise.all([loadClubContext(), loadSystemStatus()]);
      setStatus(`Auto-tildeling ferdig. ${result.assigned_count || 0} kamper ble tildelt.`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.registeredPlayerList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-registration]");

    if (!button || !state.selectedTournamentOpsId) {
      return;
    }

    try {
      await api(`/tournaments/${state.selectedTournamentOpsId}/registrations/${Number(button.dataset.removeRegistration)}`, {
        method: "DELETE",
        auth: true,
      });
      await loadClubContext();
      setStatus("Spiller fjernet fra turneringen.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  elements.registrationRosterList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-add-registration]");

    if (!button || !state.selectedTournamentOpsId) {
      return;
    }

    try {
      await api(`/tournaments/${state.selectedTournamentOpsId}/registrations`, {
        method: "POST",
        body: { player_id: Number(button.dataset.addRegistration) },
        auth: true,
      });
      await loadClubContext();
      setStatus("Spiller meldt på turneringen.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
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

  elements.pairingRequestList.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-approve-pairing]");

    if (!form) {
      return;
    }

    event.preventDefault();
    const kioskId = Number(new FormData(form).get("kiosk_id") || 0);

    if (kioskId <= 0) {
      setStatus("Velg et board for å godkjenne pairing.", "error");
      return;
    }

    try {
      await api(`/clubs/${state.selectedClubId}/kiosk-pairing-requests/${form.dataset.approvePairing}/approve`, {
        method: "POST",
        body: { kiosk_id: kioskId },
        auth: true,
      });

      setStatus("Nettbrett paret til valgt board.", "success");
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
    await submitAdminForm(elements.kioskForm, `/clubs/${state.selectedClubId}/kiosks`, "Kiosk opprettet med automatisk generert kode.");
  });

  elements.screenDeviceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.screenDeviceForm, `/clubs/${state.selectedClubId}/screen-devices`, "Skjermkode opprettet.");
  });

  elements.tournamentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAdminForm(elements.tournamentForm, `/clubs/${state.selectedClubId}/tournaments`, "Turnering opprettet.");
  });

  elements.matchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = collectFormValues(elements.matchForm);

    if (!body.tournament_id) {
      setStatus("Velg turnering før du oppretter kamp.", "error");
      return;
    }

    try {
      await api(`/tournaments/${body.tournament_id}/matches`, {
        method: "POST",
        body,
        auth: true,
      });

      elements.matchForm.reset();
      if (state.selectedTournamentOpsId) {
        elements.matchTournamentId.value = String(state.selectedTournamentOpsId);
      }
      populateAdminSelects();
      setStatus("Kamp opprettet.", "success");
      await loadClubContext();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

async function bootstrap() {
  bindEvents();
  const params = new URLSearchParams(window.location.search);
  state.highlightedPairingCode = (params.get("pairing") || "").trim().toUpperCase();

  if (state.highlightedPairingCode) {
    setActiveView("boards");
  }

  renderActiveView();

  try {
    await loadCurrentUser();

    if (hasAdminAccess()) {
      await loadClubs();
      await loadClubContext();
    }

    setStatus("Admin Studio er klar.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

bootstrap();
