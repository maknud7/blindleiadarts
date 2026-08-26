const API_ROOT = "../api/v1";
const params = new URLSearchParams(window.location.search);
const clubSlug = params.get("club") || "blindleia-dartklubb";

const el = Object.fromEntries([
  "standbyState", "activeExperience", "checkinStage", "liveDashboard",
  "clubName", "tournamentName", "tournamentMeta", "connectionLabel", "progressCards", "boards",
  "queue", "results", "tables", "playoffSection", "playoffChampion", "playoff", "elo", "highlights", "updatedAt",
  "checkinTournamentName", "checkinCode", "checkinWindow", "checkinCount", "checkinProgressBar",
  "checkinRosterCount", "checkinParticipants",
].map((id) => [id, document.getElementById(id)]));

const state = { payload: null, checkin: null, phase: "loading", socket: null, poll: null, realtime: null, loading: false };

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function asDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatDateTime(value) {
  const date = asDate(value);
  if (!date) return value ? String(value) : "";
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function formatTime(value) {
  const date = asDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(date);
}
async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data;
}

function setPhase(phase) {
  if (state.phase === phase) return;
  state.phase = phase;
  document.body.classList.remove("phase-loading", "phase-standby", "phase-checkin", "phase-live");
  document.body.classList.add(`phase-${phase}`);
  el.standbyState?.classList.toggle("hidden", phase !== "standby");
  el.activeExperience?.classList.toggle("hidden", phase === "standby" || phase === "loading");
  el.checkinStage?.classList.toggle("hidden", phase !== "checkin");
  el.liveDashboard?.classList.toggle("hidden", phase !== "live");
  if (phase === "standby") document.title = "Blindleia Dartklubb";
}

function sameLocalDay(value, reference = new Date()) {
  const date = asDate(value);
  if (!date) return false;
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}
function livePayloadIsRelevant(payload) {
  const status = String(payload?.tournament?.status || "");
  if (status === "in_progress" || status === "ready") return true;
  if (status !== "completed") return false;
  const finished = payload?.tournament?.end_at || payload?.tournament?.start_at;
  const date = asDate(finished);
  if (!date) return false;
  return sameLocalDay(date) || (Date.now() - date.getTime() >= 0 && Date.now() - date.getTime() <= 8 * 60 * 60 * 1000);
}

function participantStatus(status) {
  if (status === "checked_in") return "Sjekket inn";
  if (status === "waitlisted") return "Venteliste";
  return "Påmeldt";
}
function participantClass(status) {
  if (status === "checked_in") return "checked-in";
  if (status === "waitlisted") return "waitlisted";
  return "registered";
}
function renderCheckin(data) {
  const checkin = data?.active ? data.checkin : null;
  if (!checkin?.code) return false;
  state.checkin = checkin;
  state.payload = null;

  const total = Math.max(0, Number(checkin.participant_count || 0));
  const checkedIn = Math.max(0, Number(checkin.checked_in_count || 0));
  const participants = Array.isArray(checkin.participants) ? checkin.participants : [];
  const progress = total > 0 ? Math.min(100, Math.round((checkedIn / total) * 100)) : 0;

  el.clubName.textContent = "Blindleia Dartklubb";
  el.tournamentName.textContent = checkin.tournament_name || "Turnering";
  const start = formatDateTime(checkin.start_at);
  el.tournamentMeta.textContent = start ? `Innsjekk · ${start}` : "Innsjekk";
  el.connectionLabel.textContent = "Innsjekk";
  el.checkinTournamentName.textContent = checkin.tournament_name || "Turnering";
  el.checkinCode.textContent = checkin.code;
  const startTime = formatTime(checkin.start_at);
  el.checkinWindow.textContent = startTime ? `Turneringen starter kl. ${startTime}` : "Innsjekk er åpen";
  el.checkinCount.textContent = `${checkedIn} av ${total} sjekket inn`;
  el.checkinProgressBar.style.width = `${progress}%`;
  el.checkinRosterCount.textContent = String(participants.length || total);
  el.checkinParticipants.innerHTML = participants.length
    ? participants.map((player) => `<div class="checkin-person ${participantClass(String(player.status || ""))}"><strong>${esc(player.display_name)}</strong><span class="checkin-person-status">${esc(participantStatus(String(player.status || "")))}</span></div>`).join("")
    : `<div class="checkin-empty">Ingen påmeldte ennå.</div>`;
  document.title = `${checkin.tournament_name || "Blindleia Darts"} · Innsjekk`;
  return true;
}

function renderProgress(progress = {}) {
  const cards = [
    ["Ferdige", `${Number(progress.completed || 0)}/${Number(progress.total || 0)}`],
    ["Pågår", Number(progress.in_progress || 0)],
    ["Kalt opp", Number(progress.assigned || 0)],
    ["I kø", Number(progress.pending || 0)],
    ["Fremdrift", `${Number(progress.percent || 0).toFixed(0)}%`],
  ];
  el.progressCards.innerHTML = cards.map(([label, value]) => `<div class="stat-card"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join("");
}

function renderBoards(boards = []) {
  if (!boards.length) {
    el.boards.innerHTML = `<div class="empty">Ingen skiver er koblet til turneringen ennå.</div>`;
    return;
  }
  el.boards.innerHTML = boards.map((board) => {
    const match = board.live_match;
    if (!match) return `<article class="board-card idle"><div class="board-top"><span class="board-number">Skive ${Number(board.board_number)}</span><span class="badge">Ledig</span></div><p class="muted">Venter på neste kamp.</p></article>`;
    const playing = match.status === "in_progress";
    const aActive = Number(match.current_player_id) === Number(match.player_a.id);
    const bActive = Number(match.current_player_id) === Number(match.player_b.id);
    return `<article class="board-card">
      <div class="board-top"><span class="board-number">Skive ${Number(board.board_number)}</span><span class="badge ${playing ? "live" : ""}">${playing ? "LIVE" : "Klar"}</span></div>
      <div class="players">
        <div class="player-line ${aActive ? "active" : ""}"><strong>${esc(match.player_a.display_name)}</strong><span class="remaining">${Number(match.player_a.remaining)}</span><span class="legs">${Number(match.player_a.legs_won)}</span></div>
        <div class="player-line ${bActive ? "active" : ""}"><strong>${esc(match.player_b.display_name)}</strong><span class="remaining">${Number(match.player_b.remaining)}</span><span class="legs">${Number(match.player_b.legs_won)}</span></div>
      </div>
      <div class="round">${esc(match.round_label || match.bracket_label || "Kamp")}${match.leg_number ? ` · Leg ${Number(match.leg_number)}` : ""} · Best of ${Number(match.best_of_legs)}</div>
    </article>`;
  }).join("");
}

function renderQueue(items = []) {
  el.queue.innerHTML = items.length ? items.map((match) => `<div class="list-row"><div><strong>${esc(match.player_a_name)} – ${esc(match.player_b_name)}</strong><small>${esc(match.round_label || match.bracket_label || "Kamp")}</small></div><span class="badge">venter</span></div>`).join("") : `<div class="empty">Ingen kamper venter.</div>`;
}
function renderResults(items = []) {
  el.results.innerHTML = items.length ? items.map((match) => `<div class="list-row"><div><strong>${esc(match.winner_name || "Ferdig")}</strong><small>${esc(match.player_a_name)} – ${esc(match.player_b_name)} · ${esc(match.round_label || match.bracket_label || "Kamp")}</small></div><span class="result-score">${Number(match.legs_a || 0)}–${Number(match.legs_b || 0)}</span></div>`).join("") : `<div class="empty">Ingen ferdige kamper ennå.</div>`;
}
function renderTables(data = {}) {
  const groups = data.groups || [];
  el.tables.innerHTML = groups.length ? groups.map((group) => `<article class="table-card"><h3>${esc(group.name)}</h3><div class="table-scroll"><table class="portal-table"><thead><tr><th>#</th><th>Spiller</th><th>K</th><th>V</th><th>U</th><th>T</th><th>Leg</th><th>P</th></tr></thead><tbody>${(group.rows || []).map((row) => `<tr><td>${Number(row.position)}</td><td><strong>${esc(row.display_name)}</strong></td><td>${Number(row.played)}</td><td>${Number(row.wins)}</td><td>${Number(row.draws)}</td><td>${Number(row.losses)}</td><td>${Number(row.leg_diff) >= 0 ? "+" : ""}${Number(row.leg_diff)}</td><td><strong>${Number(row.points)}</strong></td></tr>`).join("")}</tbody></table></div></article>`).join("") : `<div class="empty">Tabellen kommer når kampene er i gang.</div>`;
}
function playoffStatus(node) {
  const status = String(node.status || "");
  if (status === "in_progress") return "LIVE";
  if (status === "assigned") return node.board_number ? `Skive ${Number(node.board_number)}` : "Kalt opp";
  if (status === "pending" || status === "ready") return "Venter";
  if (status === "completed") return "Ferdig";
  if (status === "bye") return "Bye";
  return "Venter";
}
function renderPlayoff(data) {
  if (!data?.playoff) {
    el.playoffSection?.classList.add("hidden");
    return;
  }
  el.playoffSection?.classList.remove("hidden");
  el.playoffChampion.textContent = data.playoff.champion_name ? `🏆 ${data.playoff.champion_name}` : `${Number(data.entries?.length || 0)} kvalifiserte`;
  el.playoff.innerHTML = (data.rounds || []).map((round) => `<section class="live-bracket-round"><h3>${esc(round.label)}</h3><div class="live-bracket-matches">${(round.nodes || []).map((node) => `<article class="live-bracket-match">
    <div class="live-bracket-player ${Number(node.winner_player_id) === Number(node.player_a_id) ? "winner" : ""}">${node.player_a_name ? esc(node.player_a_name) : "Venter …"}</div>
    <div class="live-bracket-player ${Number(node.winner_player_id) === Number(node.player_b_id) ? "winner" : ""}">${node.player_b_name ? esc(node.player_b_name) : "Venter …"}</div>
    <small>${esc(playoffStatus(node))}</small>
  </article>`).join("")}</div></section>`).join("");
}
function renderElo(rows = []) {
  el.elo.innerHTML = rows.length ? rows.map((row) => `<div class="list-row"><span class="rank">#${Number(row.position)}</span><div><strong>${esc(row.display_name)}</strong><small>${Number(row.elo_matches_played || 0)} ELO-kamper</small></div><span class="rating">${Number(row.elo_rating || 1000).toFixed(1)}</span></div>`).join("") : `<div class="empty">Ingen ELO-data.</div>`;
}
function renderHighlights(highlights = {}) {
  const items = [
    ["Høy checkout", Number(highlights.highest_checkout || 0)],
    ["180", Number(highlights.score_180 || 0)],
    ["Beste snitt", Number(highlights.best_average || 0).toFixed(2)],
  ];
  el.highlights.innerHTML = items.map(([label, value]) => `<div class="highlight"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join("");
}
function render(payload) {
  state.payload = payload;
  state.checkin = null;
  el.clubName.textContent = payload.club?.name || "Blindleia Dartklubb";
  el.tournamentName.textContent = payload.tournament?.name || "Live";
  const status = String(payload.tournament?.status || "");
  const statusText = status === "in_progress" ? "Pågår" : status === "completed" ? "Ferdig" : status === "ready" ? "Klar til start" : "";
  el.tournamentMeta.textContent = `${statusText}${payload.tournament?.start_at ? ` · ${formatDateTime(payload.tournament.start_at)}` : ""}`;
  el.connectionLabel.textContent = status === "completed" ? "Ferdig" : status === "ready" ? "Klar til start" : "Live";
  el.updatedAt.textContent = `Oppdatert ${new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
  renderProgress(payload.progress);
  renderBoards(payload.boards);
  renderQueue(payload.next_matches);
  renderResults(payload.recent_results);
  renderTables(payload.tables);
  renderPlayoff(payload.playoff);
  renderElo(payload.elo);
  renderHighlights(payload.highlights);
  document.title = `${payload.tournament?.name || "Blindleia Darts"} · Live`;
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [liveResult, checkinResult] = await Promise.allSettled([
      api(`/public/clubs/${encodeURIComponent(clubSlug)}/live`),
      api(`/public/check-in-display?club_slug=${encodeURIComponent(clubSlug)}`),
    ]);
    const checkin = checkinResult.status === "fulfilled" ? checkinResult.value : null;
    const live = liveResult.status === "fulfilled" ? liveResult.value : null;

    if (checkin?.active && renderCheckin(checkin)) {
      setPhase("checkin");
      return;
    }
    if (live && livePayloadIsRelevant(live)) {
      render(live);
      setPhase("live");
      return;
    }

    state.payload = null;
    state.checkin = null;
    setPhase("standby");
  } finally {
    state.loading = false;
  }
}
async function realtimeConfig() {
  if (state.realtime) return state.realtime;
  try { state.realtime = await api("/realtime/config"); }
  catch { state.realtime = { enabled: false }; }
  return state.realtime;
}
function startPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => load().catch(() => undefined), 3000);
}
async function startRealtime() {
  // Keep a lightweight poll running even with websockets so the screen can move
  // between standby, check-in and live without requiring a realtime event.
  startPolling();
  const config = await realtimeConfig();
  const clubId = Number(state.payload?.club?.id || 0);
  if (!config?.enabled || !config.websocket_url || !clubId) return;
  try {
    const socket = new WebSocket(config.websocket_url);
    state.socket = socket;
    socket.addEventListener("open", () => {
      if (state.phase === "live") el.connectionLabel.textContent = "Live";
      socket.send(JSON.stringify({ type: "subscribe", channels: [`club:${clubId}`] }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type === "event" && message?.event === "snapshot") load().catch(() => undefined);
      } catch { /* ignore malformed event */ }
    });
    socket.addEventListener("close", () => {
      state.socket = null;
      if (state.phase === "live") el.connectionLabel.textContent = "Oppdaterer";
      setTimeout(() => startRealtime().catch(() => undefined), 2500);
    });
    socket.addEventListener("error", () => socket.close());
  } catch { /* polling is already active */ }
}

load().then(startRealtime).catch(() => { setPhase("standby"); startPolling(); });
