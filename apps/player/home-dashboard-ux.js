const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./home-dashboard-ux.css?v=20260827-1535", import.meta.url).href;
document.head.appendChild(stylesheet);

const API_ROOT = "../api/v1";
const statsGrid = document.getElementById("statsGrid");
const rankingList = document.getElementById("rankingList");
const matchList = document.getElementById("myMatchList");
const statsSection = statsGrid?.closest('[data-portal-section="home"]') || null;
const matchesSection = document.getElementById("myMatches");

let observer = null;
let refreshTimer = null;
let refreshing = false;
let modelCache = null;
let lastPlayerId = 0;

function token() {
  return localStorage.getItem("bd:token") || "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, { auth = false } = {}) {
  const headers = {};
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, { headers, cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function directApi(path) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function resolveClubId() {
  let id = Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
  if (id) return id;
  const clubs = await api("/clubs");
  id = Number(clubs.items?.[0]?.id || 0);
  if (id) localStorage.setItem("bd:playerClubId", String(id));
  return id;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value, digits = 0) {
  return number(value).toLocaleString("nb-NO", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameDay) return "i dag";
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short" }).format(date);
}

function normalizeName(value) {
  return String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
}

function currentStreak(matches) {
  let streak = 0;
  for (const match of matches || []) {
    if (match.result !== "win") break;
    streak += 1;
  }
  return streak;
}

function bestAverage(matches) {
  return (matches || []).reduce((best, match) => {
    const avg = number(match.average, -1);
    return avg > number(best?.average, -1) ? match : best;
  }, null);
}

function eloMovements(profile) {
  const history = (profile?.elo_history || [])
    .map((item) => ({ ...item, rating: number(item.rating, NaN), tournament_id: number(item.tournament_id) }))
    .filter((item) => Number.isFinite(item.rating));

  const movements = history.map((item, index) => {
    const before = Number.isFinite(history[index + 1]?.rating) ? history[index + 1].rating : null;
    return {
      ...item,
      before,
      after: item.rating,
      delta: before === null ? null : Number((item.rating - before).toFixed(1)),
      used: false,
    };
  });

  const grouped = new Map();
  movements.forEach((item) => {
    if (!item.tournament_id) return;
    if (!grouped.has(item.tournament_id)) grouped.set(item.tournament_id, []);
    grouped.get(item.tournament_id).push(item);
  });

  const byMatch = new Map();
  (profile?.recent_matches || []).forEach((match) => {
    const movement = (grouped.get(number(match.tournament_id)) || []).find((item) => !item.used);
    if (!movement) return;
    movement.used = true;
    byMatch.set(number(match.id), movement);
  });

  return { history, movements, byMatch };
}

function completedTournamentElo(model) {
  return (model?.tournamentElo || [])
    .filter((item) => item?.completed && Number.isFinite(Number(item.rating_after)))
    .sort((a, b) => String(a.start_at || "").localeCompare(String(b.start_at || "")) || number(a.tournament_id) - number(b.tournament_id));
}

function latestTournamentElo(model) {
  return completedTournamentElo(model).at(-1) || null;
}

function sparkline(tournaments) {
  const completed = (tournaments || [])
    .filter((item) => item?.completed && Number.isFinite(Number(item.rating_after)))
    .sort((a, b) => String(a.start_at || "").localeCompare(String(b.start_at || "")) || number(a.tournament_id) - number(b.tournament_id));

  if (!completed.length) {
    return `<div class="home-elo-empty"><span>Ingen ferdige turneringer ennå</span><small>Første punkt kommer når en turnering ferdigstilles.</small></div>`;
  }

  const width = 460;
  const height = 118;
  const pad = 8;
  const values = completed.map((item) => number(item.rating_after, NaN)).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = completed.map((item, index) => {
    const value = number(item.rating_after);
    const x = completed.length === 1
      ? width / 2
      : pad + (index / (completed.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return { item, value, x, y };
  });
  const pointString = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${pad},${height - pad} ${pointString} ${width - pad},${height - pad}` : "";

  return `<div class="home-elo-chart-wrap" data-tournament-point-count="${completed.length}">
    <div class="home-elo-range"><span>${formatNumber(max, 1)}</span><span>${formatNumber(min, 1)}</span></div>
    <svg class="home-elo-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="ELO etter hver ferdige turnering">
      ${area ? `<polygon points="${area}" class="home-elo-area"></polygon>` : ""}
      ${points.length > 1 ? `<polyline points="${pointString}" class="home-elo-line"></polyline>` : ""}
      ${points.map((point, index) => {
        const delta = number(point.item.delta, 0);
        const title = `${point.item.tournament_name || "Turnering"}: ${formatNumber(point.value, 1)} (${delta > 0 ? "+" : ""}${formatNumber(delta, 1)})`;
        const latest = index === points.length - 1;
        return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" fill="${latest ? "#2f6fed" : "#ffffff"}" stroke="#2f6fed" stroke-width="3" vector-effect="non-scaling-stroke"><title>${esc(title)}</title></circle>`;
      }).join("")}
    </svg>
  </div>`;
}

async function loadModel() {
  if (!token()) return null;
  const clubId = await resolveClubId();
  const [meData, dashboardData] = await Promise.all([
    api("/auth/me", { auth: true }),
    api("/me/dashboard", { auth: true }),
  ]);
  const me = meData.user || null;
  const dashboard = dashboardData.dashboard || {};
  const playerId = number(me?.player?.id);
  if (!playerId) return { clubId, me, dashboard, profile: null, season: null, seasonRow: null, totalPlayers: 0, tournamentElo: [] };

  const [profile, seasonsData, tournamentEloData] = await Promise.all([
    api(`/players/${playerId}/profile`).catch(() => null),
    api(`/clubs/${clubId}/seasons`).catch(() => ({ items: [] })),
    directApi(`../api/player-elo-tournaments.php?player_id=${encodeURIComponent(playerId)}`).catch(() => ({ items: [] })),
  ]);
  const seasons = seasonsData?.items || [];
  const season = seasons.find((item) => item.is_active || item.status === "active") || seasons[0] || null;
  const tournamentElo = (tournamentEloData?.items || []).filter((item) => !season?.id || number(item.season_id) === number(season.id));
  let seasonRow = null;
  let totalPlayers = 0;
  if (season?.id) {
    const standings = await api(`/seasons/${number(season.id)}/standings`).catch(() => null);
    const rows = standings?.items || [];
    totalPlayers = rows.length;
    const aliases = new Set((profile?.player?.alias_player_ids || [playerId]).map(number));
    seasonRow = rows.find((row) => aliases.has(number(row.id)))
      || rows.find((row) => normalizeName(row.display_name) === normalizeName(profile?.player?.display_name || me?.player?.display_name))
      || null;
  }
  return { clubId, me, dashboard, profile, season, seasonRow, totalPlayers, tournamentElo };
}

function statCard(icon, label, value, note, extra = "") {
  return `<article class="home-stat-card">
    <div class="home-stat-icon" aria-hidden="true">${esc(icon)}</div>
    <div class="home-stat-copy"><span>${esc(label)}</span><strong>${value}</strong>${extra}<small>${esc(note)}</small></div>
  </article>`;
}

function renderStats(model) {
  if (!statsGrid || !model) return;
  const stats = model.dashboard?.stats || {};
  const profileStats = model.profile?.stats || {};
  const row = model.seasonRow || {};
  const recent = model.profile?.recent_matches || [];
  const best = bestAverage(recent);
  const streak = currentStreak(recent);
  const latestTournament = latestTournamentElo(model);

  const matches = row.matches_played ?? stats.matches_played ?? 0;
  const wins = row.wins ?? stats.matches_won ?? 0;
  const winPct = number(matches) > 0 ? (number(wins) / number(matches)) * 100 : number(profileStats.win_percentage);
  const threeDa = number(row.three_dart_average || profileStats.three_dart_average, 0);
  const elo = number(row.elo_rating || model.profile?.elo?.rating, 1000);
  const position = number(row.position, 0);
  const eloDelta = latestTournament?.delta;
  const eloExtra = eloDelta === null || eloDelta === undefined
    ? ""
    : `<b class="home-stat-trend ${number(eloDelta) > 0 ? "positive" : number(eloDelta) < 0 ? "negative" : "neutral"}">${number(eloDelta) > 0 ? "↑" : number(eloDelta) < 0 ? "↓" : "•"} ${number(eloDelta) > 0 ? "+" : ""}${formatNumber(eloDelta, 1)}</b>`;

  statsGrid.className = "stats-grid home-dashboard-grid";
  statsGrid.innerHTML = [
    statCard("K", "Kamper", formatNumber(matches), model.season ? `I ${model.season.name}` : "Registrert totalt"),
    statCard("V", "Seire", formatNumber(wins), number(matches) ? `${formatNumber(winPct, 1)}% seiersprosent` : "Ingen kamper ennå"),
    statCard("L", "Legs vunnet", formatNumber(stats.legs_won || profileStats.legs_won || 0), "Registrert totalt"),
    statCard("3D", "3DA snitt", threeDa > 0 ? formatNumber(threeDa, 2) : "—", model.season ? `I ${model.season.name}` : "Registrert snitt"),
    statCard("E", "ELO nå", formatNumber(elo, 1), latestTournament ? "Endring i siste turnering" : "Gjeldende rating", eloExtra),
    statCard("#", "Sesongranking", position ? `#${position}` : "—", model.totalPlayers ? `Av ${model.totalPlayers} spillere` : "Ingen plassering ennå"),
    statCard("↗", "Seire på rad", formatNumber(streak), "Nåværende streak"),
    statCard("★", "Beste 3DA", best && number(best.average) > 0 ? formatNumber(best.average, 2) : "—", best?.opponent_name ? `Mot ${best.opponent_name}` : "Siste registrerte kamper"),
  ].join("");
}

function renderSeasonOverview(model) {
  if (!rankingList || !model) return;
  const row = model.seasonRow || {};
  const profile = model.profile || {};
  const tournaments = completedTournamentElo(model);
  const latestTournament = tournaments.at(-1) || null;
  const currentElo = number(row.elo_rating || profile.elo?.rating, 1000);
  const points = number(row.points, 0);
  const position = number(row.position, 0);
  const total = number(model.totalPlayers, 0);
  const percentile = position && total ? Math.max(0, Math.min(100, ((total - position + 1) / total) * 100)) : 0;
  const delta = latestTournament?.delta;
  const deltaText = delta === null || delta === undefined ? "" : `${number(delta) > 0 ? "+" : ""}${formatNumber(delta, 1)}`;

  rankingList.className = "home-season-overview";
  rankingList.innerHTML = `
    <div class="home-season-overview-head">
      <div><h3>Sesongoversikt</h3><p class="muted">${esc(model.season?.name || "Ranking og ELO-utvikling")}</p></div>
      ${model.season ? `<span class="pill">${model.season.is_active || model.season.status === "active" ? "Aktiv sesong" : "Sesong"}</span>` : ""}
    </div>
    <div class="home-season-overview-body">
      <section class="home-ranking-hero">
        <span>Din ranking</span>
        <strong>${position ? `#${position}` : "—"}</strong>
        <small>${total ? `av ${total} spillere` : "Ingen plassering ennå"}</small>
        <div class="home-ranking-meter"><i style="width:${percentile.toFixed(1)}%"></i></div>
        <b>${position && total ? `Topp ${formatNumber((position / total) * 100, 1)}%` : ""}</b>
      </section>
      <div class="home-season-mini-grid">
        <article><span>ELO nå</span><strong>${formatNumber(currentElo, 1)}</strong>${deltaText ? `<small class="${number(delta) > 0 ? "positive" : number(delta) < 0 ? "negative" : ""}">${number(delta) > 0 ? "↑" : number(delta) < 0 ? "↓" : ""} ${esc(deltaText)} siste turnering</small>` : `<small>Gjeldende rating</small>`}</article>
        <article><span>Sesongpoeng</span><strong>${formatNumber(points, points % 1 ? 1 : 0)}</strong><small>Totalt opptjent</small></article>
      </div>
      <section class="home-elo-panel">
        <div class="home-elo-panel-head"><div><span>ELO-utvikling</span><small>Én måling per ferdig turnering</small></div><strong>${formatNumber(currentElo, 1)}</strong></div>
        ${sparkline(tournaments)}
      </section>
    </div>
    <div class="home-season-note">ELO beregnes etter hver kamp. Grafen viser sluttverdien etter hver ferdige turnering.</div>`;
}

function resultTone(label) {
  const value = normalizeName(label);
  if (value.startsWith("seier")) return "win";
  if (value.startsWith("uavgjort")) return "draw";
  return "loss";
}

function decorateMatches(model) {
  if (!matchList || !model?.profile) return;
  const movements = eloMovements(model.profile).byMatch;
  matchList.querySelectorAll("button.history-row-button").forEach((button) => {
    if (button.dataset.homeDashboardStyled === "1") return;
    const title = button.querySelector("strong")?.textContent?.trim() || "Kamp";
    const meta = button.querySelector("small")?.textContent?.trim() || "";
    const dateText = button.querySelector(":scope > span")?.textContent?.trim() || "";
    const resultMatch = title.match(/^(Seier|Tap|Uavgjort)\s+mot\s+(.+)$/i);
    const result = resultMatch?.[1] || title.split(" ")[0] || "Kamp";
    const opponent = resultMatch?.[2] || title.replace(/^(Seier|Tap|Uavgjort)\s*/i, "");
    const averageMatch = meta.match(/3DA\s+([0-9]+(?:[.,][0-9]+)?)/i);
    const average = averageMatch ? number(averageMatch[1].replace(",", "."), NaN) : NaN;
    const context = meta.replace(/\s*·\s*3DA\s+[0-9]+(?:[.,][0-9]+)?\s*$/i, "");
    const movement = movements.get(number(button.dataset.matchDetail)) || null;
    const tone = resultTone(result);
    const delta = movement?.delta;
    const deltaMarkup = delta === null || delta === undefined
      ? `<span class="home-match-elo muted">ELO <b>—</b></span>`
      : `<span class="home-match-elo ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">ELO <b>${delta > 0 ? "+" : ""}${formatNumber(delta, 1)}</b></span>`;

    button.dataset.homeDashboardStyled = "1";
    button.classList.add("home-match-row", `home-match-${tone}`);
    button.innerHTML = `
      <span class="home-match-status ${tone}">${esc(result)}</span>
      <span class="home-match-opponent"><strong>mot ${esc(opponent)}</strong><small>${esc(context)}</small></span>
      <span class="home-match-metric"><small>3DA</small><strong>${Number.isFinite(average) ? formatNumber(average, 2) : "—"}</strong></span>
      ${deltaMarkup}
      <span class="home-match-date">${esc(dateText || formatDate(model.profile?.recent_matches?.find((match) => number(match.id) === number(button.dataset.matchDetail))?.finished_at))}</span>
      <span class="home-match-chevron" aria-hidden="true">›</span>`;
  });

  const allButton = matchList.querySelector(".my-matches-all");
  const header = matchesSection?.querySelector(":scope > .section-head");
  if (allButton && header && !header.contains(allButton)) {
    allButton.classList.add("home-matches-all-link");
    header.appendChild(allButton);
  }
}

function enhanceSectionChrome() {
  if (statsSection) {
    statsSection.classList.add("home-stats-section");
    const head = statsSection.querySelector(":scope > .section-head");
    const eyebrow = head?.querySelector(".eyebrow");
    const title = head?.querySelector("h2");
    if (eyebrow) eyebrow.textContent = "Mine tall";
    if (title) title.textContent = "Statistikkoversikt";
    if (head && !head.querySelector(".home-dashboard-subtitle")) {
      const subtitle = document.createElement("p");
      subtitle.className = "muted home-dashboard-subtitle";
      subtitle.textContent = "Din prestasjon, ranking og ELO samlet på ett sted.";
      title?.insertAdjacentElement("afterend", subtitle);
    }
  }
  matchesSection?.classList.add("home-matches-section");
}

function disconnectObserver() {
  observer?.disconnect();
}

function connectObserver() {
  if (!observer) {
    observer = new MutationObserver(() => scheduleRefresh());
  }
  [statsGrid, rankingList, matchList].filter(Boolean).forEach((node) => observer.observe(node, { childList: true, subtree: true }));
}

function render(model) {
  disconnectObserver();
  try {
    enhanceSectionChrome();
    renderStats(model);
    renderSeasonOverview(model);
    decorateMatches(model);
  } finally {
    connectObserver();
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const model = await loadModel();
    if (!model) {
      modelCache = null;
      lastPlayerId = 0;
      return;
    }
    modelCache = model;
    lastPlayerId = number(model.me?.player?.id);
    render(model);
  } catch {
    if (modelCache) render(modelCache);
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh(delay = 120) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    if (modelCache && token() && lastPlayerId) {
      disconnectObserver();
      try {
        enhanceSectionChrome();
        renderStats(modelCache);
        renderSeasonOverview(modelCache);
        decorateMatches(modelCache);
      } finally {
        connectObserver();
      }
      return;
    }
    refresh().catch(() => undefined);
  }, delay);
}

function initialize() {
  if (!statsGrid || !rankingList) return;
  enhanceSectionChrome();
  connectObserver();
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "home") scheduleRefresh(20);
  });
  window.addEventListener("storage", (event) => {
    if (!["bd:token", "bd:playerClubId"].includes(event.key)) return;
    modelCache = null;
    lastPlayerId = 0;
    refresh().catch(() => undefined);
  });
  refresh().catch(() => undefined);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();