const profileRoot = document.getElementById("playerProfile");
const historyCache = new Map();
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

function formatDate(value) {
  if (!value) return "";
  const date = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function tone(delta) {
  if (Math.abs(Number(delta || 0)) < 0.05) return "neutral";
  return Number(delta) > 0 ? "positive" : "negative";
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
    historyCache.set(playerId, json(`../api/player-elo-history.php?player_id=${playerId}`).catch(() => null));
  }
  return historyCache.get(playerId);
}

function movementHtml(item, compact = false) {
  const before = Number(item.rating_before);
  const after = Number(item.rating_after);
  const delta = Number(item.delta || 0);
  const deltaText = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `<span class="elo-movement exact-elo ${tone(delta)}${compact ? " compact" : ""}">
    <span class="elo-movement-label">ELO</span>
    <span class="elo-before">${before.toFixed(1)}</span>
    <span class="elo-arrow">→</span>
    <strong class="elo-after">${after.toFixed(1)}</strong>
    <b class="elo-delta">${deltaText}</b>
  </span>`;
}

function resultLabel(result) {
  if (result === "win") return "Seier";
  if (result === "loss") return "Tap";
  return "Uavgjort";
}

function currentPlayerId() {
  return Number(profileRoot?.querySelector("[data-player]")?.dataset.player || profileRoot?.dataset.playerId || 0);
}

async function patchProfile() {
  if (!profileRoot || profileRoot.classList.contains("hidden")) return;
  const playerId = currentPlayerId();
  if (!playerId) return;
  const data = await exactHistory(playerId);
  const items = data?.items || [];
  if (!items.length) return;

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

  const signature = items.map((item) => `${item.match_id}:${Number(item.rating_before).toFixed(4)}:${Number(item.rating_after).toFixed(4)}`).join("|");
  if (eloSection.dataset.exactEloSignature === signature) return;

  const rows = items.map((item) => {
    const round = item.round_label || item.bracket_label || "Kamp";
    const context = [item.tournament_name, round, formatDate(item.finished_at || item.start_at || item.applied_at)].filter(Boolean).join(" · ");
    return `<div class="elo-timeline-row" data-exact-match-elo="${Number(item.match_id)}">
      <div class="elo-timeline-context">
        <strong>${esc(resultLabel(item.result))} mot ${esc(item.opponent_name || "motstander")}</strong>
        <small>${esc(context)}</small>
      </div>
      ${movementHtml(item)}
    </div>`;
  }).join("");

  eloSection.innerHTML = `<h3>ELO-utvikling</h3>
    <p class="muted">Eksakt ELO før og etter hver kamp. Alle starter sesongen på 1000.</p>
    <div class="elo-timeline">${rows}</div>`;
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
