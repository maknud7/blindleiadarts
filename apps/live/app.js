const LIVE_URL = "../api/dartsatlas-public-live.php";
const MATCHES_URL = "../api/dartsatlas-public-matches.php";

const state = {
  timer: null,
  refreshing: false,
  live: null,
  matches: { live_matches: [], recent_results: [] },
  lastSuccessAt: null,
};

const elements = {
  clubMark: document.getElementById("clubMark"),
  tournamentName: document.getElementById("tournamentName"),
  tournamentMeta: document.getElementById("tournamentMeta"),
  liveDot: document.getElementById("liveDot"),
  feedLabel: document.getElementById("feedLabel"),
  updatedLabel: document.getElementById("updatedLabel"),
  pollLabel: document.getElementById("pollLabel"),
  liveMatches: document.getElementById("liveMatches"),
  total180: document.getElementById("total180"),
  highestCheckout: document.getElementById("highestCheckout"),
  highestCheckoutPlayer: document.getElementById("highestCheckoutPlayer"),
  bestAverage: document.getElementById("bestAverage"),
  bestAveragePlayer: document.getElementById("bestAveragePlayer"),
  nextMatches: document.getElementById("nextMatches"),
  recentResults: document.getElementById("recentResults"),
  standings: document.getElementById("standings"),
  averages: document.getElementById("averages"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value, decimals = 2) {
  const parsed = number(value);
  return parsed === null ? "—" : parsed.toFixed(decimals);
}

function initials(value) {
  return String(value || "Blindleia Dartklubb")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function relativeUpdatedLabel() {
  if (!state.lastSuccessAt) return "Ikke oppdatert ennå";
  const seconds = Math.max(0, Math.round((Date.now() - state.lastSuccessAt.getTime()) / 1000));
  if (seconds < 4) return "Oppdatert nå";
  if (seconds < 60) return `Oppdatert for ${seconds} sek siden`;
  return `Oppdatert ${state.lastSuccessAt.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}`;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

function playerMeta(player) {
  const bits = [];
  if (number(player?.average) !== null) bits.push(`AVG ${formatNumber(player.average)}`);
  if (number(player?.score_180, 0) > 0) bits.push(`180 × ${number(player.score_180, 0)}`);
  if (number(player?.highest_checkout) !== null && number(player.highest_checkout) > 0) {
    bits.push(`CO ${number(player.highest_checkout)}`);
  }
  return bits.length ? bits.join(" · ") : "Venter på kampstatistikk";
}

function renderPlayer(player, currentPlayerId) {
  const remaining = number(player?.remaining);
  const legs = number(player?.legs_won, 0);
  const throwing = Number(currentPlayerId || 0) === Number(player?.id || -1);
  return `
    <div class="player-row ${throwing ? "is-throwing" : ""}">
      <div>
        <span class="player-name">${escapeHtml(player?.display_name || "Spiller")}</span>
        <span class="player-stats">${escapeHtml(playerMeta(player))}</span>
      </div>
      <div class="player-score">
        <strong>${remaining === null ? "—" : remaining}</strong>
        <span>${legs} legs</span>
      </div>
    </div>`;
}

function renderLiveMatch(match) {
  const board = number(match.provider_board_number);
  const round = match.round_label || match.bracket_label || "Live kamp";
  return `
    <article class="match-card">
      <div class="match-topline">
        <span class="match-round">${escapeHtml(round)}</span>
        <span class="match-pill">${board === null ? "DartsAtlas Live" : `DartsAtlas · Board ${board}`}</span>
      </div>
      ${renderPlayer(match.player_a, match.current_player_id)}
      ${renderPlayer(match.player_b, match.current_player_id)}
    </article>`;
}

function renderNextMatch(match) {
  const round = match.round_label || match.bracket_label || "Neste kamp";
  return `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(match.player_a_name)} – ${escapeHtml(match.player_b_name)}</strong>
        <small>${escapeHtml(round)}</small>
      </div>
      <span class="match-pill">${match.status === "assigned" ? "Klar" : "Venter"}</span>
    </div>`;
}

function renderResult(match) {
  const scoreA = number(match.player_a_legs);
  const scoreB = number(match.player_b_legs);
  const score = scoreA !== null && scoreB !== null ? `${scoreA}–${scoreB}` : "Ferdig";
  const round = match.round_label || match.bracket_label || "Kamp";
  return `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(match.player_a_name)} – ${escapeHtml(match.player_b_name)}</strong>
        <small>${escapeHtml(round)}${match.winner_name ? ` · Vinner: ${escapeHtml(match.winner_name)}` : ""}</small>
      </div>
      <span class="list-value">${escapeHtml(score)}</span>
    </div>`;
}

function renderStanding(entry, index) {
  const points = number(entry.match_points, 0);
  const diff = number(entry.leg_diff, 0);
  return `
    <div class="list-row">
      <div>
        <strong><span class="rank">${index + 1}</span>${escapeHtml(entry.display_name)}</strong>
        <small>${escapeHtml(entry.record || "0-0")} · leg diff ${diff >= 0 ? "+" : ""}${diff}</small>
      </div>
      <span class="list-value">${points} p</span>
    </div>`;
}

function renderAverage(entry, index) {
  return `
    <div class="list-row">
      <div>
        <strong><span class="rank">${index + 1}</span>${escapeHtml(entry.display_name)}</strong>
        <small>${escapeHtml(entry.round_label || entry.bracket_label || "Match")}</small>
      </div>
      <span class="list-value">${formatNumber(entry.three_dart_average)}</span>
    </div>`;
}

function emptyRow(message) {
  return `<div class="empty-state"><strong>${escapeHtml(message)}</strong><span>Oppdateres automatisk.</span></div>`;
}

function renderFeedStatus(hasLiveMatches) {
  const feed = state.live?.feed || {};
  const status = String(feed.status || "idle");
  elements.liveDot.className = "live-dot";

  if (hasLiveMatches) {
    elements.liveDot.classList.add("is-live");
    elements.feedLabel.textContent = "LIVE";
    return;
  }

  if (status === "delayed" || status === "stale") {
    elements.liveDot.classList.add("is-delayed");
    elements.feedLabel.textContent = status === "stale" ? "Venter på nye data" : "Litt forsinket";
    return;
  }

  if (status === "error") {
    elements.liveDot.classList.add("is-error");
    elements.feedLabel.textContent = "DartsAtlas utilgjengelig";
    return;
  }

  elements.feedLabel.textContent = "Venter på kampstart";
}

function render() {
  const live = state.live || {};
  const tournament = live.tournament || null;
  const club = live.club || null;
  const liveMatches = Array.isArray(state.matches.live_matches) ? state.matches.live_matches : [];
  const recentResults = Array.isArray(state.matches.recent_results) ? state.matches.recent_results : [];
  const nextMatches = Array.isArray(live.next_matches) ? live.next_matches : [];
  const standings = Array.isArray(live.standings) ? live.standings : [];
  const stats = live.stats && !Array.isArray(live.stats) ? live.stats : {};
  const highlights = stats.highlights || {};
  const averages = Array.isArray(stats.best_match_averages) ? stats.best_match_averages : [];
  const hasLiveMatches = liveMatches.length > 0;

  if (club?.name) {
    elements.clubMark.textContent = initials(club.name);
  }

  elements.tournamentName.textContent = tournament?.name || "Live fra DartsAtlas";
  elements.tournamentMeta.textContent = tournament
    ? `${club?.name || "Blindleia Dartklubb"} · turneringen følges automatisk`
    : "Venter på at kveldens turnering dukker opp i DartsAtlas";

  renderFeedStatus(hasLiveMatches);
  elements.updatedLabel.textContent = relativeUpdatedLabel();
  elements.pollLabel.textContent = hasLiveMatches ? "Live · skjermen sjekker hvert 2. sek" : "Venter · sjekker hvert 30. sek";

  elements.liveMatches.innerHTML = hasLiveMatches
    ? liveMatches.map(renderLiveMatch).join("")
    : emptyRow(tournament ? "Ingen kamp er markert live akkurat nå" : "Venter på kveldens turnering");

  elements.nextMatches.innerHTML = nextMatches.length
    ? nextMatches.slice(0, 8).map(renderNextMatch).join("")
    : emptyRow("Ingen neste kamper registrert ennå");

  elements.recentResults.innerHTML = recentResults.length
    ? recentResults.slice(0, 8).map(renderResult).join("")
    : emptyRow("Ingen ferdige kamper registrert ennå");

  elements.standings.innerHTML = standings.length
    ? standings.slice(0, 8).map(renderStanding).join("")
    : emptyRow("Tabellen fylles når resultatene kommer");

  elements.averages.innerHTML = averages.length
    ? averages.slice(0, 5).map(renderAverage).join("")
    : emptyRow("Matchsnitt kommer når DartsAtlas leverer statistikk");

  elements.total180.textContent = String(number(highlights.total_180, 0));

  const checkout = highlights.highest_checkout || null;
  elements.highestCheckout.textContent = checkout && number(checkout.value) !== null ? String(number(checkout.value)) : "—";
  elements.highestCheckoutPlayer.textContent = checkout?.display_name || "Ingen registrert ennå";

  const best = highlights.best_average || null;
  elements.bestAverage.textContent = best && number(best.value) !== null ? formatNumber(best.value) : "—";
  elements.bestAveragePlayer.textContent = best?.display_name || "Ingen registrert ennå";
}

function scheduleNext(delay) {
  if (state.timer) window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => refresh().catch(() => undefined), delay);
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  let nextDelay = 30000;

  try {
    const live = await getJson(`${LIVE_URL}?_=${Date.now()}`);
    let matchData = { live_matches: [], recent_results: [] };

    if (live?.tournament?.id) {
      matchData = await getJson(`${MATCHES_URL}?tournament_id=${encodeURIComponent(live.tournament.id)}&_=${Date.now()}`);
    }

    state.live = live;
    state.matches = matchData;
    state.lastSuccessAt = new Date();
    nextDelay = Array.isArray(matchData.live_matches) && matchData.live_matches.length > 0 ? 2000 : 30000;
    render();
  } catch (error) {
    elements.liveDot.className = "live-dot is-error";
    elements.feedLabel.textContent = "Mistet kontakt";
    elements.updatedLabel.textContent = state.lastSuccessAt ? relativeUpdatedLabel() : error.message;
    nextDelay = 15000;
  } finally {
    state.refreshing = false;
    scheduleNext(nextDelay);
  }
}

window.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => undefined);
});

refresh().catch(() => undefined);
