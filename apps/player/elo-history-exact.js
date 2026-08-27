const API_ROOT = "../api/v1";
const profileRoot = document.getElementById("playerProfile");
const homeMatchRoot = document.getElementById("myMatchList");

const eventCache = new Map();
const profileCache = new Map();
let refreshTimer = 0;
let running = false;
let rerun = false;

function esc(value) {
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

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function tone(delta) {
  if (delta === null || Math.abs(delta) < 0.05) return "neutral";
  return delta > 0 ? "positive" : "negative";
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

function matchEvent(matchId) {
  matchId = Number(matchId || 0);
  if (!matchId) return Promise.resolve(null);
  if (!eventCache.has(matchId)) {
    eventCache.set(matchId, json(`../api/match-elo.php?match_id=${matchId}`).then((data) => data?.event || null).catch(() => null));
  }
  return eventCache.get(matchId);
}

function playerProfile(playerId) {
  playerId = Number(playerId || 0);
  if (!playerId) return Promise.resolve(null);
  if (!profileCache.has(playerId)) {
    profileCache.set(playerId, json(`${API_ROOT}/players/${playerId}/profile`).catch(() => null));
  }
  return profileCache.get(playerId);
}

function aliases(profile, fallbackId) {
  return new Set((profile?.player?.alias_player_ids || [fallbackId]).map(Number).filter((id) => id > 0));
}

function movementFor(event, aliasIds) {
  if (!event) return null;
  const a = Number(event.player_a_id || 0);
  const b = Number(event.player_b_id || 0);
  let before;
  let after;
  let delta;
  if (aliasIds.has(a)) {
    before = num(event.rating_a_before);
    after = num(event.rating_a_after);
    delta = num(event.delta_a);
  } else if (aliasIds.has(b)) {
    before = num(event.rating_b_before);
    after = num(event.rating_b_after);
    delta = num(event.delta_b);
  } else {
    return null;
  }
  if (before === null || after === null) return null;
  if (delta === null) delta = Number((after - before).toFixed(6));
  return { before, after, delta };
}

function movementHtml(movement, compact = false) {
  if (!movement) return "";
  const delta = Number(movement.delta || 0);
  const deltaText = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `<span class="elo-movement exact-elo ${tone(delta)}${compact ? " compact" : ""}">
    <span class="elo-movement-label">ELO</span>
    <span class="elo-before">${movement.before.toFixed(1)}</span>
    <span class="elo-arrow">→</span>
    <strong class="elo-after">${movement.after.toFixed(1)}</strong>
    <b class="elo-delta">${deltaText}</b>
  </span>`;
}

function resultLabel(match) {
  if (match?.result === "win") return "Seier";
  if (match?.result === "loss") return "Tap";
  return "Uavgjort";
}

function currentProfilePlayerId() {
  const button = profileRoot?.querySelector("[data-player]");
  return Number(button?.dataset.player || profileRoot?.dataset.playerId || 0);
}

async function patchProfile() {
  if (!profileRoot || profileRoot.classList.contains("hidden")) return;
  const playerId = currentProfilePlayerId();
  if (!playerId) return;
  const profile = await playerProfile(playerId);
  if (!profile) return;
  const aliasIds = aliases(profile, playerId);
  const matches = profile.recent_matches || [];
  const pairs = await Promise.all(matches.map(async (match) => ({
    match,
    movement: movementFor(await matchEvent(match.id), aliasIds),
  })));
  const exactByMatch = new Map(pairs.filter((item) => item.movement).map((item) => [Number(item.match.id), item.movement]));

  profileRoot.querySelectorAll(".profile-match-history [data-match-detail]").forEach((row) => {
    const movement = exactByMatch.get(Number(row.dataset.matchDetail || 0));
    if (!movement) return;
    const key = `${movement.before.toFixed(4)}:${movement.after.toFixed(4)}`;
    if (row.dataset.exactElo === key) return;
    row.querySelectorAll(".elo-movement").forEach((node) => node.remove());
    const date = row.querySelector(":scope > span");
    if (date) date.insertAdjacentHTML("beforebegin", movementHtml(movement, true));
    else row.insertAdjacentHTML("beforeend", movementHtml(movement, true));
    row.dataset.exactElo = key;
  });

  const eloSection = [...profileRoot.querySelectorAll(".profile-section")].find((section) => {
    const heading = (section.querySelector("h3")?.textContent || "").toLocaleLowerCase("nb-NO");
    return heading.includes("elo-utvikling") || heading.includes("elo-historikk");
  });
  if (!eloSection) return;

  const exactPairs = pairs.filter((item) => item.movement);
  const signature = exactPairs.map(({ match, movement }) => `${match.id}:${movement.before.toFixed(4)}:${movement.after.toFixed(4)}`).join("|");
  if (eloSection.dataset.exactEloSignature === signature) return;

  const rows = exactPairs.map(({ match, movement }) => {
    const round = match.round_label || match.bracket_label || "Kamp";
    const context = [match.tournament_name, round, formatDate(match.finished_at || match.start_at)].filter(Boolean).join(" · ");
    return `<div class="elo-timeline-row" data-exact-match-elo="${Number(match.id)}">
      <div class="elo-timeline-context">
        <strong>${esc(resultLabel(match))} mot ${esc(match.opponent_name || "motstander")}</strong>
        <small>${esc(context)}</small>
      </div>
      ${movementHtml(movement)}
    </div>`;
  }).join("");

  eloSection.innerHTML = `<h3>ELO-utvikling</h3>
    <p class="muted">Eksakt ELO før og etter hver kamp. Alle starter sesongen på 1000.</p>
    <div class="elo-timeline">${rows || '<p class="muted">Ingen kampvis ELO-historikk ennå.</p>'}</div>`;
  eloSection.dataset.exactEloSignature = signature;
}

async function patchHome() {
  if (!homeMatchRoot) return;
  const visibleRows = [...homeMatchRoot.querySelectorAll("[data-match-detail]")];
  if (!visibleRows.length) return;
  const playerId = Number(document.querySelector("#playerProfile [data-player]")?.dataset.player || 0);
  if (!playerId) return;
  const profile = await playerProfile(playerId);
  if (!profile) return;
  const aliasIds = aliases(profile, playerId);

  await Promise.all(visibleRows.map(async (row) => {
    const matchId = Number(row.dataset.matchDetail || 0);
    const movement = movementFor(await matchEvent(matchId), aliasIds);
    if (!movement) return;
    const slot = row.querySelector(".home-match-elo");
    if (!slot) return;
    const delta = movement.delta;
    const key = `${movement.before.toFixed(4)}:${movement.after.toFixed(4)}`;
    if (slot.dataset.exactElo === key) return;
    slot.className = `home-match-elo exact-elo ${tone(delta)}`;
    slot.innerHTML = `<small>ELO</small><b>${delta > 0 ? "+" : ""}${delta.toFixed(1)}</b>`;
    slot.title = `${movement.before.toFixed(1)} → ${movement.after.toFixed(1)}`;
    slot.dataset.exactElo = key;
  }));
}

async function refresh() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    await Promise.all([patchProfile(), patchHome()]);
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
  const observer = new MutationObserver(() => schedule(100));
  [profileRoot, homeMatchRoot].filter(Boolean).forEach((node) => observer.observe(node, { childList: true, subtree: true }));
  window.addEventListener("bd:portal-view", () => schedule(30));
  schedule(250);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
