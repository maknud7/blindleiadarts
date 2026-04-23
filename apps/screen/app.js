const API_ROOT = "../api/v1";

const state = {
  screen: null,
  clubId: 0,
  clubSlug: new URLSearchParams(window.location.search).get("club")?.trim() || "",
  liveSource: null,
  pollHandle: null,
  reconnectHandle: null,
  realtimeConfig: null,
};

const elements = {
  brandLogo: document.getElementById("brandLogo"),
  brandFallback: document.getElementById("brandFallback"),
  brandTitle: document.getElementById("brandTitle"),
  tournamentLabel: document.getElementById("tournamentLabel"),
  headerMeta: document.getElementById("headerMeta"),
  refreshButton: document.getElementById("refreshButton"),
  boardsGrid: document.getElementById("boardsGrid"),
  nextMatches: document.getElementById("nextMatches"),
  fallbackPanel: document.getElementById("fallbackPanel"),
  fallbackLogo: document.getElementById("fallbackLogo"),
  fallbackLogoMark: document.getElementById("fallbackLogoMark"),
  fallbackTitle: document.getElementById("fallbackTitle"),
  fallbackMessage: document.getElementById("fallbackMessage"),
};

async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`);
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

async function loadScreen() {
  const query = state.clubSlug ? `?club_slug=${encodeURIComponent(state.clubSlug)}` : "";
  const payload = await api(`/public/screen${query}`);
  applyLivePayload(payload);
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
  if (state.reconnectHandle || !state.clubId) {
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

  state.screen = payload;
  state.clubId = Number(payload.club?.id || 0);
  if (!state.clubSlug && payload.club?.slug) {
    state.clubSlug = payload.club.slug;
  }
  render();
}

async function startLiveUpdates() {
  closeLiveUpdates();

  if (!state.clubId) {
    state.pollHandle = window.setInterval(() => loadScreen().catch(() => undefined), 1500);
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
        // ignore malformed SSE payloads
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

  return "Venter";
}

function visitText(visit) {
  if (!visit) {
    return "Ingen registrerte visits ennå";
  }

  const bust = Number(visit.is_bust || 0) === 1 ? " • bust" : "";
  return `${visit.player_name}: ${visit.score}${bust}`;
}

function renderBoard(board) {
  const kiosk = board.kiosk || {};
  const match = board.match;
  const sponsor = kiosk.sponsor_label || kiosk.name || `Board ${kiosk.board_number}`;
  const statusClass = board.state === "in_progress" ? "status-live" : board.state === "assigned" ? "status-assigned" : "status-idle";

  if (!match) {
    return `
      <article class="board-card">
        <div class="board-top">
          <div class="board-title">
            <strong>${kiosk.name || `Board ${kiosk.board_number}`}</strong>
            <span class="board-sponsor">${sponsor}</span>
          </div>
          <span class="status-chip ${statusClass}">Ledig</span>
        </div>
        <div class="board-empty">
          Venter på neste kamp på denne skiva.
        </div>
      </article>
    `;
  }

  const playerAActive = Number(match.current_player_id || 0) === Number(match.player_a.id);
  const playerBActive = Number(match.current_player_id || 0) === Number(match.player_b.id);
  const recentVisits = Array.isArray(match.recent_visits) ? match.recent_visits : [];

  return `
    <article class="board-card ${board.state === "in_progress" ? "is-live" : "is-assigned"}">
      <div class="board-top">
        <div class="board-title">
          <strong>${kiosk.name || `Board ${kiosk.board_number}`}</strong>
          <span class="board-sponsor">${sponsor}</span>
        </div>
        <span class="status-chip ${statusClass}">${formatStatus(board.state)}</span>
      </div>

      <div class="matchup">
        <div class="player-panel ${playerAActive ? "is-active" : ""}">
          <span class="player-label">Spiller A</span>
          <div class="player-name">${match.player_a.display_name}</div>
          <div class="player-scoreline">
            <span class="remaining">${match.player_a.remaining}</span>
            <span class="legs">${match.player_a.legs_won} legs</span>
          </div>
        </div>

        <div class="versus">vs</div>

        <div class="player-panel ${playerBActive ? "is-active" : ""}">
          <span class="player-label">Spiller B</span>
          <div class="player-name">${match.player_b.display_name}</div>
          <div class="player-scoreline">
            <span class="remaining">${match.player_b.remaining}</span>
            <span class="legs">${match.player_b.legs_won} legs</span>
          </div>
        </div>
      </div>

      <div class="visit-strip">
        <div class="visit-card">
          <strong>${visitText(recentVisits[0] || null)}</strong>
          <small>Siste visit</small>
        </div>
        <div class="visit-card">
          <strong>${visitText(recentVisits[1] || null)}</strong>
          <small>Forrige visit</small>
        </div>
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
      <div class="header-meta">
        <span class="pill">${boardText}</span>
        <span class="pill">${match.status === "assigned" ? "Tildelt" : "Venter"}</span>
      </div>
    </article>
  `;
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
  const fallback = screen.fallback || null;

  const clubInitials = initials(club.name);
  applyImage(elements.brandLogo, elements.brandFallback, club.logo_url, `${club.name || "Klubb"} logo`, clubInitials);
  applyImage(elements.fallbackLogo, elements.fallbackLogoMark, club.logo_url, `${club.name || "Klubb"} logo`, clubInitials);

  elements.brandTitle.textContent = club.name || "Dartklubb";
  elements.tournamentLabel.textContent = tournament
    ? tournament.name
    : fallback?.title || "Ingen aktiv turnering";

  elements.headerMeta.innerHTML = tournament
    ? `
        <span class="pill">${tournament.status}</span>
        <span class="pill">${tournament.registration_count || 0} påmeldte</span>
        <span class="pill">${tournament.match_count || 0} kamper</span>
      `
    : `<span class="pill">Venter</span>`;

  elements.boardsGrid.innerHTML = boards.length
    ? boards.map(renderBoard).join("")
    : `<article class="board-card"><div class="board-empty">Ingen boards med aktiv eller tildelt kamp akkurat nå.</div></article>`;

  elements.nextMatches.innerHTML = nextMatches.length
    ? nextMatches.map(renderNextMatch).join("")
    : `<article class="list-item"><p class="muted">Ingen neste kamper akkurat nå.</p></article>`;

  const shouldShowFallback = !tournament || (boards.every((board) => board.state === "idle") && nextMatches.length === 0);
  elements.fallbackPanel.classList.toggle("hidden", !shouldShowFallback);
  elements.fallbackTitle.textContent = fallback?.title || `Velkommen til ${club.name || "dartklubben"}`;
  elements.fallbackMessage.textContent = fallback?.message || "Ingen kamper er i gang akkurat nå.";
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => loadScreen());
}

async function bootstrap() {
  bindEvents();
  await loadScreen();
  await startLiveUpdates();
}

bootstrap();
