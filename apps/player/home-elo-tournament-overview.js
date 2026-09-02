const rankingRoot = document.getElementById("rankingList");
let patchTimer = 0;
let patching = false;
let cachedContext = null;

const style = document.createElement("style");
style.textContent = `
  .home-elo-chart .home-elo-point{fill:#fff;stroke:#2f6fed;stroke-width:3;vector-effect:non-scaling-stroke}
  .home-elo-chart .home-elo-point.latest{fill:#2f6fed}
`;
document.head.appendChild(style);

function token() {
  return localStorage.getItem("bd:token") || "";
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value, digits = 1) {
  return number(value).toLocaleString("nb-NO", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function json(url, { auth = false } = {}) {
  const headers = {};
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
    return payload.data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function resolveContext() {
  if (cachedContext && token()) return cachedContext;
  if (!token()) return null;

  const me = await json("../api/v1/auth/me", { auth: true });
  const playerId = Number(me?.user?.player?.id || 0);
  if (!playerId) return null;

  let clubId = Number(localStorage.getItem("bd:playerClubId") || document.getElementById("clubSelect")?.value || 0);
  if (!clubId) {
    const clubs = await json("../api/v1/clubs");
    clubId = Number(clubs?.items?.[0]?.id || 0);
  }

  let seasonId = 0;
  if (clubId) {
    const seasons = await json(`../api/v1/clubs/${clubId}/seasons`).catch(() => ({ items: [] }));
    const current = (seasons?.items || []).find((item) => item.is_active || item.status === "active") || seasons?.items?.[0];
    seasonId = Number(current?.id || 0);
  }

  cachedContext = { playerId, seasonId };
  return cachedContext;
}

function chartHtml(items) {
  const completed = items
    .filter((item) => item.completed && Number.isFinite(Number(item.rating_after)))
    .sort((a, b) => String(a.start_at || "").localeCompare(String(b.start_at || "")) || Number(a.tournament_id) - Number(b.tournament_id));

  if (!completed.length) {
    return `<div class="home-elo-empty"><span>Ingen ferdige turneringer ennå</span><small>Første punkt kommer når en turnering ferdigstilles.</small></div>`;
  }

  const width = 460;
  const height = 118;
  const pad = 8;
  const values = completed.map((item) => Number(item.rating_after));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = completed.map((item, index) => {
    const x = completed.length === 1
      ? width / 2
      : pad + (index / (completed.length - 1)) * (width - pad * 2);
    const y = height - pad - ((Number(item.rating_after) - min) / range) * (height - pad * 2);
    return { item, x, y };
  });
  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = points.length > 1
    ? `${pad},${height - pad} ${polyline} ${width - pad},${height - pad}`
    : "";

  return `<div class="home-elo-chart-wrap" data-tournament-point-count="${completed.length}">
    <div class="home-elo-range"><span>${formatNumber(max, 1)}</span><span>${formatNumber(min, 1)}</span></div>
    <svg class="home-elo-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="ELO etter hver ferdige turnering">
      ${area ? `<polygon points="${area}" class="home-elo-area"></polygon>` : ""}
      ${points.length > 1 ? `<polyline points="${polyline}" class="home-elo-line"></polyline>` : ""}
      ${points.map((point, index) => `<circle class="home-elo-point${index === points.length - 1 ? " latest" : ""}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${esc(point.item.tournament_name || "Turnering")} · ${formatNumber(point.item.rating_after, 1)}</title></circle>`).join("")}
    </svg>
  </div>`;
}

async function patch() {
  if (!rankingRoot || patching || !token()) return;
  const panel = rankingRoot.querySelector(".home-elo-panel");
  if (!panel) return;

  patching = true;
  try {
    const context = await resolveContext();
    if (!context?.playerId) return;
    const data = await json(`../api/player-elo-tournaments.php?player_id=${encodeURIComponent(context.playerId)}`);
    const items = (data?.items || []).filter((item) => !context.seasonId || Number(item.season_id) === context.seasonId);
    const completed = items.filter((item) => item.completed && Number.isFinite(Number(item.rating_after)));
    const signature = completed.map((item) => `${item.tournament_id}:${item.rating_after}`).join("|");
    if (panel.dataset.tournamentEloSignature === signature) return;

    const headSmall = panel.querySelector(".home-elo-panel-head small");
    if (headSmall) headSmall.textContent = "Én måling per ferdig turnering";

    const oldChart = panel.querySelector(".home-elo-chart-wrap,.home-elo-empty");
    if (oldChart) oldChart.outerHTML = chartHtml(items);
    else panel.insertAdjacentHTML("beforeend", chartHtml(items));

    const latest = completed.at(-1) || null;
    const delta = latest?.delta;
    const deltaNode = rankingRoot.querySelector(".home-season-mini-grid article:first-child small");
    if (deltaNode && delta !== null && delta !== undefined && Number.isFinite(Number(delta))) {
      const value = Number(delta);
      deltaNode.className = value > 0 ? "positive" : value < 0 ? "negative" : "";
      deltaNode.textContent = `${value > 0 ? "↑ +" : value < 0 ? "↓ " : ""}${formatNumber(value, 1)} siste turnering`;
    }

    const note = rankingRoot.querySelector(".home-season-note");
    if (note) note.textContent = "ELO beregnes fortsatt etter hver kamp. Grafen viser sluttverdien etter hver ferdige turnering.";

    panel.dataset.tournamentEloSignature = signature;
  } finally {
    patching = false;
  }
}

function schedule(delay = 80) {
  window.clearTimeout(patchTimer);
  patchTimer = window.setTimeout(() => patch().catch(() => undefined), delay);
}

function initialize() {
  if (!rankingRoot) return;
  const observer = new MutationObserver(() => schedule(60));
  observer.observe(rankingRoot, { childList: true, subtree: true });
  window.addEventListener("bd:portal-view", (event) => {
    if (event.detail?.target === "home") schedule(20);
  });
  window.addEventListener("storage", (event) => {
    if (!["bd:token", "bd:playerClubId"].includes(event.key)) return;
    cachedContext = null;
    schedule(20);
  });
  schedule(180);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
