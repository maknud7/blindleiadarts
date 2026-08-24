const CURRENT_URL = "../api/dartsatlas-public-current.php";
const SEASON_ELO_URL = "../api/dartsatlas-public-season-elo.php";

const state = {
  current: null,
  elo: null,
  refreshTimer: null,
  clockTimer: null,
};

const elements = {
  panel: document.getElementById("waitingPanel"),
  tournament: document.getElementById("waitingTournamentName"),
  start: document.getElementById("waitingStartLabel"),
  message: document.getElementById("waitingMessage"),
  days: document.getElementById("countdownDays"),
  hours: document.getElementById("countdownHours"),
  minutes: document.getElementById("countdownMinutes"),
  seconds: document.getElementById("countdownSeconds"),
  eloTable: document.getElementById("eloTable"),
  eloLeader: document.getElementById("eloLeader"),
  eloLeaderPlayer: document.getElementById("eloLeaderPlayer"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getJson(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(`HTTP ${response.status}`);
  return payload.data || {};
}

function hasTournamentActivity() {
  return Boolean(
    document.querySelector("#liveMatches .match-card") ||
    document.querySelector("#recentResults .list-row")
  );
}

function scheduledDate() {
  const raw = state.current?.scheduled_at;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatStart(date) {
  const today = new Date();
  const sameDay = date.toLocaleDateString("nb-NO") === today.toLocaleDateString("nb-NO");
  if (sameDay) {
    return `I kveld kl. ${date.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}`;
  }
  const formatted = new Intl.DateTimeFormat("nb-NO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function setCountdown(diffMs) {
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  elements.days.textContent = String(days);
  elements.hours.textContent = String(hours).padStart(2, "0");
  elements.minutes.textContent = String(minutes).padStart(2, "0");
  elements.seconds.textContent = String(seconds).padStart(2, "0");
}

function renderWaiting() {
  if (!elements.panel) return;

  const activity = hasTournamentActivity();
  const date = scheduledDate();
  const current = state.current || {};
  const waiting = !activity;

  document.body.classList.toggle("is-waiting", waiting);
  elements.panel.hidden = !waiting;
  if (!waiting) return;

  if (!date || !current.external_id) {
    elements.tournament.textContent = "Neste turnering kommer";
    elements.start.textContent = "Venter på neste publiserte turnering i DartsAtlas";
    elements.message.textContent = "Mandagsserie-ELO-en under er oppdatert og klar til neste runde.";
    setCountdown(0);
    return;
  }

  elements.tournament.textContent = current.name || "Neste turnering";
  elements.start.textContent = formatStart(date);
  const diff = date.getTime() - Date.now();
  setCountdown(diff);

  if (diff > 0) {
    elements.message.textContent = current.is_today
      ? "Vi teller ned til avkast. Livekamper og statistikk dukker opp automatisk når turneringen starter."
      : "Neste mandagsrunde er allerede på radaren. ELO-tabellen under viser utgangspunktet før første kamp.";
  } else {
    elements.message.textContent = "Planlagt starttid er passert – venter på at første kamp blir registrert i DartsAtlas.";
  }
}

function renderElo() {
  const table = Array.isArray(state.elo?.table) ? state.elo.table : [];
  if (!elements.eloTable || table.length === 0) return;

  elements.eloTable.innerHTML = table.map((entry) => `
    <div class="list-row">
      <div>
        <strong><span class="rank">${escapeHtml(entry.position)}</span>${escapeHtml(entry.display_name)}</strong>
        <small>${Number(entry.played || 0)} kamper</small>
      </div>
      <span class="list-value elo-rating">${Number(entry.rating || 1000).toFixed(1).replace(".", ",")}</span>
    </div>`).join("");

  const leader = table[0];
  if (leader && elements.eloLeader && elements.eloLeaderPlayer) {
    elements.eloLeader.textContent = Number(leader.rating || 1000).toFixed(1).replace(".", ",");
    elements.eloLeaderPlayer.textContent = leader.display_name || "";
  }
}

async function refresh() {
  const [current, elo] = await Promise.allSettled([
    getJson(CURRENT_URL),
    getJson(SEASON_ELO_URL),
  ]);

  if (current.status === "fulfilled") state.current = current.value;
  if (elo.status === "fulfilled") state.elo = elo.value?.live_elo || null;

  renderElo();
  renderWaiting();
}

state.clockTimer = window.setInterval(() => {
  renderElo();
  renderWaiting();
}, 1000);

state.refreshTimer = window.setInterval(() => refresh().catch(() => undefined), 30000);
window.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => undefined);
});

refresh().catch(() => undefined);
