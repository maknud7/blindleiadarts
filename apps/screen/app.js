const API_ROOT = "../api/v1";
const STORAGE_TOKEN_KEY = "bd:screenToken";

const state = {
  screen: null,
  clubId: 0,
  screenToken: localStorage.getItem(STORAGE_TOKEN_KEY) || "",
  liveSource: null,
  pollHandle: null,
  reconnectHandle: null,
  realtimeConfig: null,
};

const elements = {
  connectView: document.getElementById("connectView"),
  screenView: document.getElementById("screenView"),
  connectForm: document.getElementById("connectForm"),
  connectCode: document.getElementById("connectCode"),
  connectStatus: document.getElementById("connectStatus"),
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  tournamentLabel: document.getElementById("tournamentLabel"),
  screenDeviceLabel: document.getElementById("screenDeviceLabel"),
  headerMeta: document.getElementById("headerMeta"),
  refreshButton: document.getElementById("refreshButton"),
  changeClubButton: document.getElementById("changeClubButton"),
  boardsGrid: document.getElementById("boardsGrid"),
  nextMatches: document.getElementById("nextMatches"),
  standingsList: document.getElementById("standingsList"),
  eloList: document.getElementById("eloList"),
  oomList: document.getElementById("oomList"),
  topVisitsList: document.getElementById("topVisitsList"),
  bestAverageList: document.getElementById("bestAverageList"),
  fallbackPanel: document.getElementById("fallbackPanel"),
  fallbackLogo: document.getElementById("fallbackLogo"),
  fallbackLogoMark: document.getElementById("fallbackLogoMark"),
  fallbackTitle: document.getElementById("fallbackTitle"),
  fallbackMessage: document.getElementById("fallbackMessage"),
};

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    const error = new Error(payload?.error?.message || `Request failed with ${response.status}`);
    error.code = payload?.error?.code || "request_failed";
    throw error;
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

function persistScreenToken(token) {
  state.screenToken = token;

  if (token) {
    localStorage.setItem(STORAGE_TOKEN_KEY, token);
    return;
  }

  localStorage.removeItem(STORAGE_TOKEN_KEY);
}

function resolveImageUrl(url) {
  if (!url) {
    return "";
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  try {
    return new URL(url, `${window.location.origin}/`).toString();
  } catch {
    return url;
  }
}

function applyImage(image, fallback, url, alt, fallbackText) {
  if (!image || !fallback) {
    return;
  }

  fallback.textContent = fallbackText;

  if (!url) {
    image.removeAttribute("src");
    image.classList.add("hidden");
    fallback.classList.remove("hidden");
    return;
  }

  image.onload = () => {
    image.classList.remove("hidden");
    fallback.classList.add("hidden");
  };
  image.onerror = () => {
    image.classList.add("hidden");
    fallback.classList.remove("hidden");
  };
  image.alt = alt;
  image.src = resolveImageUrl(url);
}

function initials(name) {
  return (name || "Klubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function setConnectStatus(message, tone = "info") {
  elements.connectStatus.textContent = message || "";
  elements.connectStatus.dataset.tone = tone;
}

function showConnectView() {
  closeLiveUpdates();
  state.screen = null;
  state.clubId = 0;
  elements.connectView.classList.remove("hidden");
  elements.screenView.classList.add("hidden");
}

function showScreenView() {
  elements.connectView.classList.add("hidden");
  elements.screenView.classList.remove("hidden");
}

async function connectScreen(code) {
  const payload = await api("/public/screen/connect", {
    method: "POST",
    body: { code },
  });

  persistScreenToken(payload.access_token || "");
  applyLivePayload(payload.screen || null);
  showScreenView();
  setConnectStatus("");
  return payload;
}

async function loadScreen() {
  if (!state.screenToken) {
    showConnectView();
    return;
  }

  const payload = await api(`/public/screen?screen_token=${encodeURIComponent(state.screenToken)}`);
  applyLivePayload(payload);
  showScreenView();
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

  if (state.pollHandle) {
    window.clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

function scheduleReconnect() {
  if (state.reconnectHandle || !state.clubId || !state.screenToken) {
    return;
  }

  state.reconnectHandle = window.setTimeout(() => {
    state.reconnectHandle = null;
    startLiveUpdates().catch(() => undefined);
  }, 1000);
}

function applyLivePayload(payload) {
  if (!payload) {
    return;
  }

  if (!payload.screen_device && state.screen?.screen_device) {
    payload.screen_device = state.screen.screen_device;
  }

  state.screen = payload;
  state.clubId = Number(payload.club?.id || 0);
  render();
}

async function startLiveUpdates() {
  closeLiveUpdates();

  if (!state.clubId || !state.screenToken) {
    return;
  }

  const realtime = await loadRealtimeConfig();

  if (realtime?.enabled && realtime.websocket_url) {
    const socket = new WebSocket(realtime.websocket_url);
    state.liveSource = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        channels: [`club:${state.clubId}`],
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

      if (message.payload?.screen) {
        applyLivePayload(message.payload.screen);
        return;
      }

      loadScreen().catch(() => undefined);
    });

    socket.addEventListener("close", () => {
      if (state.liveSource === socket) {
        state.liveSource = null;
      }

      state.pollHandle = window.setInterval(() => loadScreen().catch(() => undefined), 1500);
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });

    return;
  }

  if (typeof window.EventSource === "function") {
    const source = new EventSource(`${API_ROOT}/clubs/${state.clubId}/live`);
    state.liveSource = source;

    source.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload?.screen) {
          applyLivePayload(payload.screen);
          return;
        }
      } catch {
        // ignore malformed payloads
      }

      loadScreen().catch(() => undefined);
    });

    source.onerror = () => {
      closeLiveUpdates();
      state.pollHandle = window.setInterval(() => loadScreen().catch(() => undefined), 1500);
      scheduleReconnect();
    };

    return;
  }

  state.pollHandle = window.setInterval(() => loadScreen().catch(() => undefined), 1500);
}

function formatStatus(status) {
  if (status === "in_progress") {
    return "Live";
  }

  if (status === "assigned") {
    return "Klar";
  }

  return "Ledig";
}

function formatBoard(board) {
  const kiosk = board.kiosk || {};
  const match = board.match;
  const boardName = kiosk.name || `Board ${kiosk.board_number || ""}`.trim();
  const sponsor = kiosk.sponsor_label || "Uten sponsor";
  const statusClass = board.state === "in_progress"
    ? "status-live"
    : board.state === "assigned"
      ? "status-assigned"
      : "status-idle";

  if (!match) {
    return `
      <article class="board-card board-card-idle">
        <div class="board-head">
          <div>
            <p class="board-name">${boardName}</p>
            <h3>${sponsor}</h3>
          </div>
          <span class="status-chip ${statusClass}">Ledig</span>
        </div>
        <p class="board-empty">Ingen aktiv kamp pa denne skiva akkurat na.</p>
      </article>
    `;
  }

  const playerAActive = Number(match.current_player_id || 0) === Number(match.player_a.id);
  const playerBActive = Number(match.current_player_id || 0) === Number(match.player_b.id);
  const visits = Array.isArray(match.recent_visits) ? match.recent_visits : [];
  const latestVisit = visits[0] || null;

  return `
    <article class="board-card ${board.state === "in_progress" ? "is-live" : "is-assigned"}">
      <div class="board-head">
        <div>
          <p class="board-name">${boardName}</p>
          <h3>${sponsor}</h3>
        </div>
        <span class="status-chip ${statusClass}">${formatStatus(board.state)}</span>
      </div>

      <div class="compact-matchup">
        <div class="compact-player ${playerAActive ? "is-active" : ""}">
          <strong>${match.player_a.display_name}</strong>
          <span>${match.player_a.legs_won} legs</span>
          <em>${match.player_a.remaining}</em>
        </div>
        <div class="compact-versus">vs</div>
        <div class="compact-player ${playerBActive ? "is-active" : ""}">
          <strong>${match.player_b.display_name}</strong>
          <span>${match.player_b.legs_won} legs</span>
          <em>${match.player_b.remaining}</em>
        </div>
      </div>

      <div class="board-foot">
        <span class="pill">${match.round_label || match.bracket_label || "Kamp"}</span>
        <span class="pill">${latestVisit ? `Siste: ${latestVisit.player_name} ${latestVisit.score}` : "Venter pa forste visit"}</span>
      </div>
    </article>
  `;
}

function renderNextMatch(match) {
  const boardText = match.board_number ? `Board ${match.board_number}` : "Ikke tildelt";

  return `
    <article class="list-item">
      <strong>${match.player_a_name} vs ${match.player_b_name}</strong>
      <p class="muted">${match.round_label || match.bracket_label || "Neste kamp"}</p>
      <div class="pill-row">
        <span class="pill">${boardText}</span>
        <span class="pill">${match.status === "assigned" ? "Kalt opp" : "Venter"}</span>
      </div>
    </article>
  `;
}

function renderStanding(entry, index) {
  return `
    <article class="table-row">
      <span class="table-rank">${index + 1}</span>
      <div class="table-name">
        <strong>${entry.display_name}</strong>
        <small>${entry.record} | Leg diff ${entry.leg_diff >= 0 ? "+" : ""}${entry.leg_diff}</small>
      </div>
      <span class="table-value">${entry.match_points} p</span>
    </article>
  `;
}

function renderRanking(entry, index) {
  return `
    <article class="table-row">
      <span class="table-rank">${entry.position || index + 1}</span>
      <div class="table-name">
        <strong>${entry.display_name}</strong>
        <small>${entry.scope_type === "tournament" ? "Turnering" : "Sesong"}</small>
      </div>
      <span class="table-value">${entry.points}</span>
    </article>
  `;
}

function renderVisit(entry, index) {
  const suffix = entry.board_number ? `Board ${entry.board_number}` : (entry.sponsor_label || "Lokalet");

  return `
    <article class="table-row">
      <span class="table-rank">${index + 1}</span>
      <div class="table-name">
        <strong>${entry.display_name}</strong>
        <small>${suffix}</small>
      </div>
      <span class="table-value">${entry.score}</span>
    </article>
  `;
}

function renderAverage(entry, index) {
  return `
    <article class="table-row">
      <span class="table-rank">${index + 1}</span>
      <div class="table-name">
        <strong>${entry.display_name}</strong>
        <small>${entry.round_label || entry.bracket_label || "Kamp"} | ${entry.visits_logged} visits</small>
      </div>
      <span class="table-value">${entry.three_dart_average}</span>
    </article>
  `;
}

function renderList(target, items, renderer, emptyText) {
  target.innerHTML = Array.isArray(items) && items.length
    ? items.map(renderer).join("")
    : `<article class="list-item"><p class="muted">${emptyText}</p></article>`;
}

function render() {
  const screen = state.screen;

  if (!screen) {
    return;
  }

  const club = screen.club || {};
  const tournament = screen.tournament || null;
  const boards = Array.isArray(screen.live_boards) ? screen.live_boards : [];
  const nextMatches = Array.isArray(screen.next_matches) ? screen.next_matches : [];
  const standings = Array.isArray(screen.standings) ? screen.standings : [];
  const stats = typeof screen.stats === "object" && screen.stats !== null ? screen.stats : {};
  const fallback = screen.fallback || null;
  const clubInitials = initials(club.name);

  applyImage(elements.brandLogo, elements.brandFallback, club.logo_url, `${club.name || "Klubb"} logo`, clubInitials);
  applyImage(elements.fallbackLogo, elements.fallbackLogoMark, club.logo_url, `${club.name || "Klubb"} logo`, clubInitials);

  elements.brandTitle.textContent = club.name || "Dartklubb";
  elements.tournamentLabel.textContent = tournament ? tournament.name : "Ingen aktiv turnering";
  elements.screenDeviceLabel.textContent = screen.screen_device?.label || "Venue Screen";

  elements.headerMeta.innerHTML = tournament
    ? `
        <span class="pill">${tournament.status}</span>
        <span class="pill">${tournament.registration_count || 0} pameldte</span>
        <span class="pill">${tournament.match_count || 0} kamper</span>
        <span class="pill">${boards.filter((board) => board.state === "in_progress").length} live</span>
      `
    : `<span class="pill">Venter</span>`;

  renderList(elements.boardsGrid, boards, formatBoard, "Ingen boards med aktiv eller tildelt kamp akkurat na.");
  renderList(elements.nextMatches, nextMatches, renderNextMatch, "Ingen neste kamper akkurat na.");
  renderList(elements.standingsList, standings, renderStanding, "Ingen tabellgrunnlag enda.");
  renderList(elements.eloList, stats.elo || [], renderRanking, "Ingen ELO-data enda.");
  renderList(elements.oomList, stats.order_of_merit || [], renderRanking, "Ingen Order of Merit-data enda.");
  renderList(elements.topVisitsList, stats.top_visits || [], renderVisit, "Ingen top visits enda.");
  renderList(elements.bestAverageList, stats.best_match_averages || [], renderAverage, "Ingen matchsnitt enda.");

  const shouldShowFallback = !tournament || (boards.every((board) => board.state === "idle") && nextMatches.length === 0);
  elements.fallbackPanel.classList.toggle("hidden", !shouldShowFallback);
  elements.fallbackTitle.textContent = fallback?.title || `Velkommen til ${club.name || "dartklubben"}`;
  elements.fallbackMessage.textContent = fallback?.message || "Ingen kamper er i gang akkurat na.";
}

async function handleConnectSubmit(event) {
  event.preventDefault();
  const code = elements.connectCode.value.trim().toUpperCase();

  if (!code) {
    setConnectStatus("Tast inn en skjermkode fra admin.", "error");
    return;
  }

  setConnectStatus("Kobler til skjermen...", "info");

  try {
    await connectScreen(code);
    await startLiveUpdates();
  } catch (error) {
    persistScreenToken("");
    showConnectView();
    setConnectStatus(error.message, "error");
  }
}

function handleChangeClub() {
  persistScreenToken("");
  elements.connectCode.value = "";
  setConnectStatus("");
  showConnectView();
}

function bindEvents() {
  elements.connectForm.addEventListener("submit", handleConnectSubmit);
  elements.refreshButton.addEventListener("click", () => loadScreen().catch(() => undefined));
  elements.changeClubButton.addEventListener("click", handleChangeClub);
}

async function bootstrap() {
  bindEvents();

  if (!state.screenToken) {
    showConnectView();
    return;
  }

  try {
    await loadScreen();
    await startLiveUpdates();
  } catch (error) {
    persistScreenToken("");
    showConnectView();
    setConnectStatus(error.message, "error");
  }
}

bootstrap();
