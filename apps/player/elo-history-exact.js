const profileRoot = document.getElementById("playerProfile");
const historyCache = new Map();
let refreshTimer = 0;
let running = false;
let rerun = false;

const eloTournamentStyle = document.createElement("link");
eloTournamentStyle.rel = "stylesheet";
eloTournamentStyle.href = new URL("./elo-tournament-history.css?v=20261110-01", import.meta.url).href;
document.head.appendChild(eloTournamentStyle);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit" }).format(date);
}

function tone(delta) {
  if (Math.abs(Number(delta || 0)) < 0.05) return "neutral";
  return Number(delta) > 0 ? "positive" : "negative";
}

function deltaText(delta) {
  const value = Number(delta || 0);
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

async function json(path) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload.data;
  } finally {
    window.clearTimeout(timer);
  }
}

function exactHistory(playerId) {
  playerId = Number(playerId || 0);
  if (!playerId) return Promise.resolve(null);
  if (!historyCache.has(playerId)) {
    historyCache.set(playerId, Promise.all([
      json(`../api/player-elo-history.php?player_id=${playerId}`).catch(() => null),
      json(`../api/player-elo-tournaments.php?player_id=${playerId}`).catch(() => null),
    ]).then(([matches, tournaments]) => ({ matches, tournaments })));
  }
  return historyCache.get(playerId);
}

function movementHtml(item, compact = false) {
  const before = Number(item.rating_before);
  const after = Number(item.rating_after);
  const delta = Number(item.delta || 0);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return "";
  return `<span class="elo-movement exact-elo ${tone(delta)}${compact ? " compact" : ""}">
    <span class="elo-movement-label">ELO</span>
    <span class="elo-before">${before.toFixed(1)}</span>
    <span class="elo-arrow">→</span>
    <strong class="elo-after">${after.toFixed(1)}</strong>
    <b class="elo-delta">${deltaText(delta)}</b>
  </span>`;
}

function resultLabel(result) {
  if (result === "win") return "Seier";
  if (result === "loss") return "Tap";
  return "Uavgjort";
}

function phaseLabel(item) {
  if (item.phase === "group") return "Gruppespill";
  if (item.phase === "playoff") return "Sluttspill";
  return "Kamp";
}

function roundLabel(item) {
  const raw = String(item.round_label || item.bracket_label || "Kamp").trim();
  const normalized = raw.toLocaleLowerCase("nb-NO");
  if (normalized.includes("quarter") || normalized.includes("kvart")) return "Kvartfinale";
  if (normalized.includes("semi")) return "Semifinale";
  if (normalized === "final" || normalized.includes("finale")) return "Finale";
  if (item.phase === "group" && Number(item.logical_round || 0) > 0 && Number(item.logical_round) < 32767) {
    return `Runde ${Number(item.logical_round)}`;
  }
  return raw;
}

function currentPlayerId() {
  return Number(profileRoot?.querySelector("[data-player]")?.dataset.player || profileRoot?.dataset.playerId || 0);
}

function chartHtml(tournaments) {
  // Calendar is sourced from ALL completed ELO-enabled tournaments, not only
  // those with a snapshot for this player. Absent events are flat points.
  const rows = tournaments.filter((item) => item.completed && Number.isFinite(Number(item.rating_after)));
  if (!rows.length) return "";

  const width = 760;
  const height = 200;
  const left = 44;
  const right = 20;
  const top = 22;
  const bottom = 35;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const ratings = rows.map((item) => Number(item.rating_after));
  let min = Math.min(...ratings);
  let max = Math.max(...ratings);
  const padding = Math.max(8, (max - min) * 0.18);
  min -= padding;
  max += padding;
  const y = (rating) => top + ((max - rating) / (max - min)) * plotHeight;
  const x = (index) => left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const points = rows.map((item, index) => ({ item, x: x(index), y: y(Number(item.rating_after)) }));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const gridValues = [max, (max + min) / 2, min];
  const labelEvery = rows.length <= 7 ? 1 : Math.ceil(rows.length / 6);
  const selected = rows.at(-1);
  const attended = rows.filter((row) => Number(row.tournament_matches || 0) > 0).length;

  return `<div class="elo-tournament-chart" data-elo-interactive-chart>
    <div class="elo-chart-heading">
      <strong>ELO etter hver tellende turnering</strong>
      <span>${rows.length} turneringer · ${attended} med ELO-kamper</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="ELO-kurve med ${rows.length} punkter, ett per ELO-tellende turnering, inkludert turneringer uten deltakelse">
      ${gridValues.map((value) => {
        const gy = y(value);
        return `<line class="elo-chart-grid" x1="${left}" x2="${width - right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"></line><text class="elo-chart-axis" x="3" y="${(gy + 3).toFixed(1)}">${value.toFixed(0)}</text>`;
      }).join("")}
      ${points.length > 1 ? `<path class="elo-chart-line" d="${path}"></path>` : ""}
      ${points.map((point, index) => {
        const item = point.item;
        const showLabel = index % labelEvery === 0 || index === points.length - 1;
        const selectedPoint = index === points.length - 1;
        const played = Number(item.tournament_matches || 0) > 0;
        return `<g class="elo-chart-event${selectedPoint ? " is-selected" : ""}${played ? "" : " is-idle"}" data-elo-chart-point-index="${index}"><circle class="elo-chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${selectedPoint ? "6" : "4.5"}"><title>${esc(item.tournament_name)}: ${Number(item.rating_after).toFixed(1)} ELO${played ? ` (${deltaText(item.delta)})` : " (ingen ELO-kamper)"}</title></circle>${showLabel ? `<text class="elo-chart-label" x="${point.x.toFixed(1)}" y="${height - 9}">${esc(shortDate(item.start_at))}</text>` : ""}</g>`;
      }).join("")}
    </svg>
    <div class="elo-chart-legend"><span><i class="elo-legend-played"></i> Spilte ELO-kamper</span><span><i class="elo-legend-missed"></i> Uendret rating</span></div>
    <div class="elo-chart-selection" role="status" aria-live="polite">${selected ? chartSelectionHtml(selected) : ""}</div>
    <div class="elo-chart-navigation" role="group" aria-label="Velg turnering i ELO-grafen">
      ${rows.map((item, index) => `<button type="button" data-elo-point-index="${index}" class="${index === rows.length - 1 ? "active" : ""}" aria-pressed="${index === rows.length - 1 ? "true" : "false"}" aria-label="${esc(item.tournament_name)} – ${esc(formatDate(item.start_at))} – ${Number(item.rating_after).toFixed(1)} ELO"><span>${esc(shortDate(item.start_at))}</span><strong>${Number(item.rating_after).toFixed(0)}</strong></button>`).join("")}
    </div>
  </div>`;
}

function chartSelectionHtml(item) {
  const matches = Number(item.tournament_matches || 0);
  const delta = Number(item.delta || 0);
  return `<div class="elo-chart-selection-context"><strong>${esc(item.tournament_name || "Turnering")}</strong><small>${esc(formatDate(item.start_at))} · ${matches > 0 ? `${matches} ELO-kamper` : "Ingen ELO-kamper – rating videreført"}</small></div>
    <div class="elo-chart-selection-rating"><strong>${Number(item.rating_after).toFixed(1)}</strong><span class="${tone(delta)}">${deltaText(delta)}</span></div>`;
}

function bindChartSelection(section, rows) {
  const chart = section.querySelector("[data-elo-interactive-chart]");
  if (!chart) return;
  const buttons = [...chart.querySelectorAll("[data-elo-point-index]")];
  buttons.forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.eloPointIndex);
    const item = rows[index];
    if (!item) return;
    buttons.forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", active ? "true" : "false");
    });
    chart.querySelectorAll("[data-elo-chart-point-index]").forEach((point) => {
      const active = Number(point.dataset.eloChartPointIndex) === index;
      point.classList.toggle("is-selected", active);
      point.querySelector("circle")?.setAttribute("r", active ? "6" : "4.5");
    });
    const selection = chart.querySelector(".elo-chart-selection");
    if (selection) selection.innerHTML = chartSelectionHtml(item);
  }));
}

function tournamentCardHtml(tournament, matchItems) {
  const matches = matchItems.filter((item) => Number(item.tournament_id) === Number(tournament.tournament_id));
  const delta = Number(tournament.delta || 0);
  const date = formatDate(tournament.start_at || tournament.end_at);
  return `<details class="elo-tournament-card">
    <summary>
      <span class="elo-tournament-title"><strong>${esc(tournament.tournament_name || "Turnering")}</strong><small>${esc(date)}${Number(tournament.tournament_matches || 0) ? ` · ${Number(tournament.tournament_matches)} ELO-kamper` : ""}</small></span>
      <span class="elo-tournament-result"><span class="before">${Number(tournament.rating_before).toFixed(1)}</span><span class="arrow">→</span><strong class="after">${Number(tournament.rating_after).toFixed(1)}</strong><b class="delta ${tone(delta)}">${deltaText(delta)}</b></span>
    </summary>
    <div class="elo-tournament-matches">
      ${matches.length ? matches.map((item) => {
        const context = [phaseLabel(item), roundLabel(item)].filter(Boolean).join(" · ");
        return `<div class="elo-tournament-match"><div><strong>${esc(resultLabel(item.result))} mot ${esc(item.opponent_name || "motstander")}</strong><small>${esc(context)}</small></div>${movementHtml(item, true)}</div>`;
      }).join("") : `<div class="elo-tournament-empty">Ingen kampvise ELO-data er registrert for denne turneringen.</div>`}
    </div>
  </details>`;
}

function tournamentOverviewHtml(tournaments, matchItems) {
  const completed = tournaments.filter((item) => item.completed && Number.isFinite(Number(item.rating_after)));
  if (!completed.length) return "";
  const first = completed[0];
  const last = completed.at(-1);
  const startRating = Number(first.rating_before);
  const latestRating = Number(last.rating_after);
  const totalDelta = latestRating - startRating;
  const cards = [...completed].filter((item) => Number(item.tournament_matches || 0) > 0).reverse()
    .map((item) => tournamentCardHtml(item, matchItems)).join("");

  return `<div class="elo-tournament-overview">
    <div class="elo-tournament-summary">
      <div class="elo-summary-stat"><small>Start</small><strong>${startRating.toFixed(1)}</strong></div>
      <div class="elo-summary-stat"><small>Sist avsluttet</small><strong>${latestRating.toFixed(1)}</strong></div>
      <div class="elo-summary-stat"><small>Total endring</small><strong class="${tone(totalDelta)}">${deltaText(totalDelta)}</strong></div>
    </div>
    ${chartHtml(completed)}
    <div class="elo-tournament-list">
      <h4>ELO-kamper per turnering</h4>
      <p class="muted">Turneringer du ikke spilte ELO-kamper i vises som flate punkter i grafen. Velg et punkt for detaljer.</p>
      ${cards || '<p class="muted">Ingen ELO-kamper i perioden.</p>'}
    </div>
  </div>`;
}

async function patchProfile() {
  if (!profileRoot || profileRoot.classList.contains("hidden")) return;
  const playerId = currentPlayerId();
  if (!playerId) return;
  const data = await exactHistory(playerId);
  if (currentPlayerId() !== playerId || profileRoot.classList.contains("hidden")) return;
  const matchData = data?.matches || null;
  const tournamentData = data?.tournaments || null;
  const items = matchData?.items || [];
  const tournaments = tournamentData?.items || [];
  // Show the full chart even if the player has no personal ELO-match events.
  // For a truly empty tournament calendar, retain a useful empty state.

  const byMatch = new Map(items.map((item) => [Number(item.match_id), item]));
  profileRoot.querySelectorAll(".profile-match-history [data-match-detail]").forEach((row) => {
    const item = byMatch.get(Number(row.dataset.matchDetail || 0));
    if (!item) return;
    const key = `${Number(item.rating_before).toFixed(4)}:${Number(item.rating_after).toFixed(4)}`;
    if (row.dataset.exactElo === key) return;
    row.querySelectorAll(".elo-movement").forEach((node) => node.remove());
    const date = row.querySelector(":scope > span");
    if (date) date.insertAdjacentHTML("beforebegin", movementHtml(item, true));
    else row.insertAdjacentHTML("beforeend", movementHtml(item, true));
    row.dataset.exactElo = key;
  });

  const eloSection = [...profileRoot.querySelectorAll(".profile-section")].find((section) => {
    const heading = (section.querySelector("h3")?.textContent || "").toLocaleLowerCase("nb-NO");
    return heading.includes("elo-utvikling") || heading.includes("elo-historikk");
  });
  if (!eloSection) return;

  const signature = `${matchData?.continuity_ok}:${tournaments.map((item) => `${item.tournament_id}:${item.rating_before}:${item.rating_after}`).join("|")}`;
  if (eloSection.dataset.exactEloSignature === signature) return;

  const overview = tournamentOverviewHtml(tournaments, items);
  if (overview) {
    eloSection.innerHTML = `<h3>ELO-utvikling</h3><p class="muted">Ett punkt for hver ELO-tellende turnering i klubben. Når spilleren ikke har ELO-kamper, går grafen flatt videre.</p>${overview}`;
    bindChartSelection(eloSection, tournaments.filter((item) => item.completed && Number.isFinite(Number(item.rating_after))));
  } else {
    const rows = items.map((item) => `<div class="elo-timeline-row"><div class="elo-timeline-context"><strong>${esc(resultLabel(item.result))} mot ${esc(item.opponent_name || "motstander")}</strong><small>${esc(item.tournament_name || "Turnering")} · ${esc(roundLabel(item))}</small></div>${movementHtml(item)}</div>`).join("");
    eloSection.innerHTML = `<h3>ELO-utvikling</h3><p class="muted">${tournamentData ? "Ingen ferdige ELO-tellende turneringer å vise ennå." : "Kunne ikke hente ELO-grafen. Oppdater for å prøve igjen."}</p><div class="elo-timeline">${rows}</div>`;
  }
  eloSection.dataset.exactEloSignature = signature;
}

async function refresh() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    await patchProfile();
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      schedule(60);
    }
  }
}

function schedule(delay = 120) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refresh().catch(() => undefined), delay);
}

function initialize() {
  if (!profileRoot) return;
  const observer = new MutationObserver(() => schedule(100));
  observer.observe(profileRoot, { childList: true, subtree: true });
  window.addEventListener("bd:portal-view", () => schedule(30));
  schedule(250);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();