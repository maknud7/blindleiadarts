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
  refreshing: false,
  eventCounters: new Map(),
  eventTimer: null,
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function num(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value, decimals = 2) {
  const parsed = num(value);
  return parsed === null ? "—" : parsed.toFixed(decimals);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
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
  if (state.realtimeConfig !== null) return state.realtimeConfig;
  try {
    state.realtimeConfig = await api("/realtime/config");
  } catch {
    state.realtimeConfig = { enabled: false, transport: "sse", websocket_url: "" };
  }
  return state.realtimeConfig;
}

function persistScreenToken(token) {
  state.screenToken = token || "";
  if (state.screenToken) localStorage.setItem(STORAGE_TOKEN_KEY, state.screenToken);
  else localStorage.removeItem(STORAGE_TOKEN_KEY);
}

function resolveImageUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  try { return new URL(url, `${window.location.origin}/`).toString(); }
  catch { return url; }
}

function applyImage(image, fallback, url, alt, fallbackText) {
  if (!image || !fallback) return;
  fallback.textContent = fallbackText;
  if (!url) {
    image.removeAttribute("src");
    image.classList.add("hidden");
    fallback.classList.remove("hidden");
    return;
  }
  image.onload = () => { image.classList.remove("hidden"); fallback.classList.add("hidden"); };
  image.onerror = () => { image.classList.add("hidden"); fallback.classList.remove("hidden"); };
  image.alt = alt;
  image.src = resolveImageUrl(url);
}

function initials(name) {
  return (name || "Klubb").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
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
  const payload = await api("/public/screen/connect", { method: "POST", body: { code } });
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
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const payload = await api(`/public/screen?screen_token=${encodeURIComponent(state.screenToken)}`);
    applyLivePayload(payload);
    showScreenView();
  } finally {
    state.refreshing = false;
  }
}

function closeLiveUpdates() {
  if (state.liveSource) {
    try { state.liveSource.close(); } catch { /* no-op */ }
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
  if (state.reconnectHandle || !state.clubId || !state.screenToken) return;
  state.reconnectHandle = window.setTimeout(() => {
    state.reconnectHandle = null;
    startLiveUpdates().catch(() => undefined);
  }, 1000);
}

function applyLivePayload(payload) {
  if (!payload) return;
  if (!payload.screen_device && state.screen?.screen_device) payload.screen_device = state.screen.screen_device;
  detectLiveEvents(payload);
  state.screen = payload;
  state.clubId = Number(payload.club?.id || 0);
  render();
}

async function startLiveUpdates() {
  closeLiveUpdates();
  if (!state.clubId || !state.screenToken) return;

  const realtime = await loadRealtimeConfig();
  if (realtime?.enabled && realtime.websocket_url) {
    const socket = new WebSocket(realtime.websocket_url);
    state.liveSource = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", channels: [`club:${state.clubId}`] })));
    socket.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type !== "event" || message?.event !== "snapshot") return;
        if (message.payload?.screen) applyLivePayload(message.payload.screen);
        else await loadScreen();
      } catch { /* ignore malformed events */ }
    });
    socket.addEventListener("close", () => {
      if (state.liveSource === socket) state.liveSource = null;
      state.pollHandle = window.setInterval(() => loadScreen().catch(() => undefined), 1500);
      scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
    return;
  }

  if (typeof window.EventSource === "function") {
    const source = new EventSource(`${API_ROOT}/clubs/${state.clubId}/live`);
    state.liveSource = source;
    source.addEventListener("snapshot", async (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.screen) applyLivePayload(payload.screen);
        else await loadScreen();
      } catch { /* ignore malformed payload */ }
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
  if (status === "in_progress") return "Live";
  if (status === "assigned") return "Klar";
  if (status === "completed") return "Ferdig";
  return "Ledig";
}

function playerStatLine(player) {
  const stats = [];
  if (num(player?.average) !== null) stats.push(`AVG ${formatNumber(player.average)}`);
  if (num(player?.score_180, 0) > 0) stats.push(`180 × ${num(player.score_180, 0)}`);
  if (num(player?.highest_checkout) !== null) stats.push(`CO ${num(player.highest_checkout)}`);
  return stats.length ? stats.join(" · ") : "Ingen live-statistikk ennå";
}

function formatBoard(board) {
  const kiosk = board.kiosk || {};
  const match = board.match;
  const boardName = kiosk.name || `Skive ${kiosk.board_number || ""}`.trim();
  const sponsor = kiosk.sponsor_label || "Blindleia Dartklubb";
  const statusClass = board.state === "in_progress" ? "status-live" : board.state === "assigned" ? "status-assigned" : "status-idle";

  if (!match) {
    return `<article class="board-card board-card-idle"><div class="board-head"><div><p class="board-name">${escapeHtml(boardName)}</p><h3>${escapeHtml(sponsor)}</h3></div><span class="status-chip ${statusClass}">Ledig</span></div><p class="board-empty">Ingen aktiv kamp på denne skiva akkurat nå.</p></article>`;
  }

  const playerAActive = Number(match.current_player_id || 0) === Number(match.player_a.id);
  const playerBActive = Number(match.current_player_id || 0) === Number(match.player_b.id);
  const visits = Array.isArray(match.recent_visits) ? match.recent_visits : [];
  const latestVisit = visits[0] || null;
  const remainingA = match.player_a.remaining === null || match.player_a.remaining === undefined ? "—" : match.player_a.remaining;
  const remainingB = match.player_b.remaining === null || match.player_b.remaining === undefined ? "—" : match.player_b.remaining;
  const footer = latestVisit
    ? `Siste: ${latestVisit.player_name} ${latestVisit.score}`
    : `${playerStatLine(match.player_a)} | ${playerStatLine(match.player_b)}`;

  return `
    <article class="board-card ${board.state === "in_progress" ? "is-live" : "is-assigned"}">
      <div class="board-head">
        <div><p class="board-name">${escapeHtml(boardName)}</p><h3>${escapeHtml(sponsor)}</h3></div>
        <span class="status-chip ${statusClass}">${formatStatus(board.state)}</span>
      </div>
      <div class="compact-matchup">
        <div class="compact-player ${playerAActive ? "is-active" : ""}"><strong>${escapeHtml(match.player_a.display_name)}</strong><span>${num(match.player_a.legs_won, 0)} legs</span><em>${escapeHtml(remainingA)}</em></div>
        <div class="compact-versus">vs</div>
        <div class="compact-player ${playerBActive ? "is-active" : ""}"><strong>${escapeHtml(match.player_b.display_name)}</strong><span>${num(match.player_b.legs_won, 0)} legs</span><em>${escapeHtml(remainingB)}</em></div>
      </div>
      <div class="board-foot"><span class="pill">${escapeHtml(match.round_label || match.bracket_label || "Kamp")}</span><span class="pill">${escapeHtml(footer)}</span></div>
    </article>`;
}

function renderNextMatch(match) {
  const boardText = match.board_number ? `Skive ${match.board_number}` : "Ikke tildelt";
  return `<article class="list-item"><strong>${escapeHtml(match.player_a_name)} vs ${escapeHtml(match.player_b_name)}</strong><p class="muted">${escapeHtml(match.round_label || match.bracket_label || "Neste kamp")}</p><div class="pill-row"><span class="pill">${escapeHtml(boardText)}</span><span class="pill">${match.status === "assigned" ? "Kalt opp" : "Venter"}</span></div></article>`;
}

function renderStanding(entry, index) {
  return `<article class="table-row"><span class="table-rank">${index + 1}</span><div class="table-name"><strong>${escapeHtml(entry.display_name)}</strong><small>${escapeHtml(entry.record || "0-0")} · Leg diff ${num(entry.leg_diff, 0) >= 0 ? "+" : ""}${num(entry.leg_diff, 0)}</small></div><span class="table-value">${num(entry.match_points, 0)} p</span></article>`;
}

function renderRanking(entry, index) {
  return `<article class="table-row"><span class="table-rank">${entry.position || index + 1}</span><div class="table-name"><strong>${escapeHtml(entry.display_name)}</strong><small>${entry.scope_type === "tournament" ? "Turnering" : "Sesong"}</small></div><span class="table-value">${escapeHtml(entry.points ?? entry.rating ?? "—")}</span></article>`;
}

function renderVisit(entry, index) {
  const suffix = entry.board_number ? `Skive ${entry.board_number}` : (entry.sponsor_label || "Lokalet");
  return `<article class="table-row"><span class="table-rank">${index + 1}</span><div class="table-name"><strong>${escapeHtml(entry.display_name)}</strong><small>${escapeHtml(suffix)}</small></div><span class="table-value">${escapeHtml(entry.score)}</span></article>`;
}

function renderAverage(entry, index) {
  return `<article class="table-row"><span class="table-rank">${index + 1}</span><div class="table-name"><strong>${escapeHtml(entry.display_name)}</strong><small>${escapeHtml(entry.round_label || entry.bracket_label || "Kamp")} · ${num(entry.visits_logged, 0)} visits</small></div><span class="table-value">${formatNumber(entry.three_dart_average ?? entry.average)}</span></article>`;
}

function highlightRows(highlights) {
  const rows = [];
  if (highlights?.highest_checkout) rows.push({ label: highlights.highest_checkout.display_name, detail: "Høyeste checkout", value: highlights.highest_checkout.value });
  if (highlights?.total_180 !== undefined) rows.push({ label: "180-klubben i kveld", detail: "Registrerte 180", value: highlights.total_180 });
  if (highlights?.best_average) rows.push({ label: highlights.best_average.display_name, detail: "Beste matchsnitt", value: formatNumber(highlights.best_average.value) });
  return rows;
}

function renderHighlight(entry, index) {
  return `<article class="table-row"><span class="table-rank">${index + 1}</span><div class="table-name"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.detail)}</small></div><span class="table-value">${escapeHtml(entry.value)}</span></article>`;
}

function renderList(target, items, renderer, emptyText) {
  target.innerHTML = Array.isArray(items) && items.length
    ? items.map(renderer).join("")
    : `<article class="list-item"><p class="muted">${escapeHtml(emptyText)}</p></article>`;
}

function render() {
  const screen = state.screen;
  if (!screen) return;
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
    ? `<span class="pill">${escapeHtml(tournament.status)}</span><span class="pill">${boards.filter((board) => board.state === "in_progress").length} live</span>`
    : `<span class="pill">Venter</span>`;

  renderList(elements.boardsGrid, boards, formatBoard, "Ingen boards med aktiv eller tildelt kamp akkurat nå.");
  renderList(elements.nextMatches, nextMatches, renderNextMatch, "Ingen neste kamper akkurat nå.");
  renderList(elements.standingsList, standings, renderStanding, "Ingen tabellgrunnlag enda.");
  renderList(elements.eloList, stats.elo || [], renderRanking, "Ingen ELO-data enda.");
  renderList(elements.oomList, stats.order_of_merit || [], renderRanking, "Ingen Order of Merit-data enda.");

  const highlights = highlightRows(stats.highlights || {});
  if (highlights.length) renderList(elements.topVisitsList, highlights, renderHighlight, "Ingen høydepunkter enda.");
  else renderList(elements.topVisitsList, stats.top_visits || [], renderVisit, "Ingen toppkast enda.");
  renderList(elements.bestAverageList, stats.best_match_averages || [], renderAverage, "Ingen matchsnitt enda.");

  const shouldShowFallback = !tournament || (boards.every((board) => board.state === "idle") && nextMatches.length === 0);
  elements.fallbackPanel.classList.toggle("hidden", !shouldShowFallback);
  elements.fallbackTitle.textContent = fallback?.title || `Velkommen til ${club.name || "dartklubben"}`;
  elements.fallbackMessage.textContent = fallback?.message || "Ingen kamper er i gang akkurat nå.";
}

function ensureEventOverlay() {
  let overlay = document.getElementById("liveEventOverlay");
  if (overlay) return overlay;
  const style = document.createElement("style");
  style.textContent = `#liveEventOverlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(4,10,18,.94);opacity:0;pointer-events:none;transition:opacity .2s ease}#liveEventOverlay.show{opacity:1}.live-event-card{text-align:center;padding:4vw 6vw}.live-event-title{font-size:clamp(4rem,12vw,11rem);font-weight:900;line-height:.9;margin:0}.live-event-player{font-size:clamp(1.8rem,4vw,4rem);font-weight:800;margin-top:2rem}.live-event-detail{font-size:clamp(1.2rem,2vw,2rem);margin-top:1rem;opacity:.8}`;
  document.head.appendChild(style);
  overlay = document.createElement("div");
  overlay.id = "liveEventOverlay";
  overlay.innerHTML = `<div class="live-event-card"><div class="live-event-title"></div><div class="live-event-player"></div><div class="live-event-detail"></div></div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function showLiveEvent(title, player, detail) {
  const overlay = ensureEventOverlay();
  overlay.querySelector(".live-event-title").textContent = title;
  overlay.querySelector(".live-event-player").textContent = player || "";
  overlay.querySelector(".live-event-detail").textContent = detail || "";
  overlay.classList.add("show");
  if (state.eventTimer) window.clearTimeout(state.eventTimer);
  state.eventTimer = window.setTimeout(() => overlay.classList.remove("show"), 3500);
}

function detectLiveEvents(payload) {
  const boards = Array.isArray(payload.live_boards) ? payload.live_boards : [];
  const initialized = state.eventCounters.size > 0;
  const nextCounters = new Map(state.eventCounters);

  for (const board of boards) {
    const match = board.match;
    if (!match) continue;
    for (const player of [match.player_a, match.player_b]) {
      if (!player?.id) continue;
      const key = `${match.id}:${player.id}`;
      const current = { score180: num(player.score_180, 0), checkout: num(player.highest_checkout, 0) };
      const previous = state.eventCounters.get(key);
      if (initialized && previous) {
        if (current.score180 > previous.score180) {
          showLiveEvent("180!", player.display_name, `Skive ${board.kiosk?.board_number || ""}`.trim());
        } else if (current.checkout > previous.checkout && current.checkout > 0) {
          showLiveEvent(`${current.checkout} CHECKOUT`, player.display_name, `Skive ${board.kiosk?.board_number || ""}`.trim());
        }
      }
      nextCounters.set(key, current);
    }
  }
  state.eventCounters = nextCounters;
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
  state.eventCounters.clear();
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
