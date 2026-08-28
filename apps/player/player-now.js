const API_ROOT = "../api/v1";
const TOKEN_KEY = "bd:token";
const CLUB_KEY = "bd:playerClubId";
const POLL_ACTIVE_MS = 5000;
const POLL_HIDDEN_MS = 15000;
const META_REFRESH_MS = 30000;

const nowState = {
  token: "",
  clubId: 0,
  playerId: 0,
  dashboard: null,
  tournaments: [],
  lastMetaAt: 0,
  lastCallSignature: "",
  timer: null,
  busy: false,
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function ensureStyles() {
  if (document.getElementById("playerNowStyles")) return;
  const style = document.createElement("style");
  style.id = "playerNowStyles";
  style.textContent = `
    #playerNowSection{position:relative;overflow:hidden;border:1px solid #c9d9ee;background:linear-gradient(135deg,#f8fbff,#edf4ff)}
    #playerNowSection.player-now-called{border-color:#87aef2;box-shadow:0 12px 30px rgba(47,111,237,.12)}
    #playerNowSection.player-now-live{border-color:#a9d9c7;background:linear-gradient(135deg,#f8fffb,#eaf7f0)}
    #playerNowSection.player-now-waiting{border-color:#d6dfeb;background:#fff}
    .player-now-layout{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:16px;align-items:center}
    .player-now-logo{width:58px;height:58px;display:grid;place-items:center;border-radius:15px;background:#fff;border:1px solid #dbe3ed;padding:5px}
    .player-now-logo img{width:100%;height:100%;object-fit:contain}
    .player-now-copy{display:grid;gap:4px;min-width:0}
    .player-now-copy .eyebrow{margin:0;color:#2f6fed;font-weight:800}
    .player-now-copy h2{margin:0;font-size:clamp(1.35rem,3vw,2rem);line-height:1.05;color:#0c2340}
    .player-now-copy p{margin:0;color:#53677f;line-height:1.4}
    .player-now-board{min-width:110px;padding:12px 14px;border-radius:16px;background:#0b2b50;color:#fff;text-align:center}
    .player-now-board small{display:block;text-transform:uppercase;letter-spacing:.09em;font-size:.7rem;opacity:.72}
    .player-now-board strong{display:block;font-size:1.35rem;margin-top:2px}
    .player-now-meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:7px}
    .player-now-meta span{display:inline-flex;align-items:center;padding:5px 8px;border-radius:999px;background:rgba(255,255,255,.72);border:1px solid #dbe3ed;color:#52677f;font-size:.8rem;font-weight:700}
    .player-now-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2f6fed;margin-right:6px;box-shadow:0 0 0 0 rgba(47,111,237,.35);animation:playerNowPulse 1.8s infinite}
    .player-now-live .player-now-pulse{background:#238060;box-shadow:0 0 0 0 rgba(35,128,96,.35)}
    @keyframes playerNowPulse{70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
    @media(max-width:640px){.player-now-layout{grid-template-columns:auto minmax(0,1fr);gap:12px}.player-now-logo{width:48px;height:48px}.player-now-board{grid-column:1/-1;width:100%;display:flex;justify-content:center;gap:6px;align-items:baseline;padding:10px}.player-now-board small,.player-now-board strong{display:inline;margin:0}.player-now-copy h2{font-size:1.45rem}}
  `;
  document.head.appendChild(style);
}

function ensureSection() {
  let section = document.getElementById("playerNowSection");
  if (section) return section;
  const firstHome = document.querySelector('[data-portal-section="home"]');
  if (!firstHome) return null;
  section = document.createElement("section");
  section.id = "playerNowSection";
  section.dataset.portalSection = "home";
  section.className = "card stack hidden";
  section.setAttribute("aria-live", "polite");
  firstHome.insertAdjacentElement("beforebegin", section);
  return section;
}

async function request(path, auth = false) {
  const headers = {};
  if (auth && nowState.token) headers.Authorization = `Bearer ${nowState.token}`;
  const response = await fetch(`${API_ROOT}${path}`, { cache: "no-store", headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.data || {};
}

function currentCredentials() {
  return {
    token: localStorage.getItem(TOKEN_KEY) || "",
    clubId: Number(localStorage.getItem(CLUB_KEY) || 0),
  };
}

async function refreshIdentity() {
  if (!nowState.token) {
    nowState.playerId = 0;
    nowState.dashboard = null;
    nowState.tournaments = [];
    return;
  }
  const me = await request("/auth/me", true);
  nowState.playerId = Number(me?.user?.player?.id || me?.user?.player_id || 0);
}

async function refreshMeta() {
  if (!nowState.token || !nowState.clubId || !nowState.playerId) return;
  const [dashboardData, tournamentData] = await Promise.all([
    request("/me/dashboard", true),
    request(`/clubs/${nowState.clubId}/registration-tournaments`),
  ]);
  nowState.dashboard = dashboardData?.dashboard || null;
  nowState.tournaments = Array.isArray(tournamentData?.items) ? tournamentData.items : [];
  nowState.lastMetaAt = Date.now();
}

function activeRegistration() {
  const registrations = Array.isArray(nowState.dashboard?.registrations) ? nowState.dashboard.registrations : [];
  const tournaments = new Map(nowState.tournaments.map((item) => [Number(item.id), item]));
  const now = Date.now();

  const candidates = registrations
    .filter((registration) => Number(registration.club_id || 0) === nowState.clubId)
    .filter((registration) => ["checked_in", "registered", "waitlisted"].includes(String(registration.status || "")))
    .map((registration) => ({ registration, tournament: tournaments.get(Number(registration.tournament_id)) || null }))
    .filter(({ tournament }) => {
      if (!tournament) return false;
      const status = String(tournament.status || "");
      if (["ready", "in_progress"].includes(status)) return true;
      const start = tournament.start_at ? new Date(String(tournament.start_at).replace(" ", "T")).getTime() : NaN;
      return Number.isFinite(start) && Math.abs(start - now) <= 18 * 60 * 60 * 1000;
    });

  candidates.sort((a, b) => {
    const priority = { checked_in: 0, registered: 1, waitlisted: 2 };
    return (priority[String(a.registration.status)] ?? 9) - (priority[String(b.registration.status)] ?? 9);
  });
  return candidates[0] || null;
}

function matchForPlayer(calls) {
  if (!nowState.playerId) return null;
  const mine = calls.filter((match) => Number(match.player_a_id) === nowState.playerId || Number(match.player_b_id) === nowState.playerId);
  return mine.find((match) => String(match.status) === "in_progress")
    || mine.find((match) => String(match.status) === "assigned")
    || null;
}

function opponent(match) {
  return Number(match.player_a_id) === nowState.playerId ? match.player_b_name : match.player_a_name;
}

function renderCall(match) {
  const section = ensureSection();
  if (!section) return;
  const status = String(match.status || "");
  const boardNumber = Number(match.board_number || 0);
  const boardLabel = boardNumber > 0 ? `Skive ${boardNumber}` : (match.kiosk_name || "Skive tildeles");
  const isLive = status === "in_progress";
  const title = isLive ? `Kamp pågår · ${boardLabel}` : `Gå til ${boardLabel}`;
  const callSignature = `${match.id}:${status}:${match.kiosk_id || 0}`;

  section.className = `card stack ${isLive ? "player-now-live" : "player-now-called"}`;
  section.setAttribute("aria-live", isLive ? "polite" : "assertive");
  section.innerHTML = `
    <div class="player-now-layout">
      <div class="player-now-logo"><img src="../static/club-logos/blindleia-dartklubb-logo.png" alt="Blindleia Dartklubb"></div>
      <div class="player-now-copy">
        <p class="eyebrow"><span class="player-now-pulse"></span>${isLive ? "Akkurat nå · spiller" : "Akkurat nå · kalt opp"}</p>
        <h2>${esc(title)}</h2>
        <p>${isLive ? "Du spiller mot" : "Du møter"} <strong>${esc(opponent(match) || "motstander")}</strong>.</p>
        <div class="player-now-meta">
          ${match.tournament_name ? `<span>${esc(match.tournament_name)}</span>` : ""}
          ${(match.round_label || match.bracket_label) ? `<span>${esc(match.round_label || match.bracket_label)}</span>` : ""}
          ${match.best_of_legs ? `<span>Best av ${Number(match.best_of_legs)}</span>` : ""}
        </div>
      </div>
      <div class="player-now-board"><small>${isLive ? "Spiller på" : "Gå til"}</small><strong>${esc(boardLabel)}</strong></div>
    </div>`;

  if (!isLive && callSignature !== nowState.lastCallSignature) {
    if (typeof navigator.vibrate === "function") navigator.vibrate([180, 90, 180]);
  }
  nowState.lastCallSignature = callSignature;
}

function renderWaiting() {
  const section = ensureSection();
  if (!section) return;
  const active = activeRegistration();
  if (!active || String(active.registration.status) !== "checked_in") {
    section.classList.add("hidden");
    section.innerHTML = "";
    nowState.lastCallSignature = "";
    return;
  }

  section.className = "card stack player-now-waiting";
  section.setAttribute("aria-live", "polite");
  section.innerHTML = `
    <div class="player-now-layout">
      <div class="player-now-logo"><img src="../static/club-logos/blindleia-dartklubb-logo.png" alt="Blindleia Dartklubb"></div>
      <div class="player-now-copy">
        <p class="eyebrow"><span class="player-now-pulse"></span>Akkurat nå · innsjekket</p>
        <h2>Venter på oppkalling</h2>
        <p>Du er klar i <strong>${esc(active.registration.tournament_name || active.tournament?.name || "turneringen")}</strong>. Når en skive faktisk er tildelt, skifter denne flaten til «Gå til Skive …».</p>
      </div>
      <div class="player-now-board"><small>Status</small><strong>Klar</strong></div>
    </div>`;
  nowState.lastCallSignature = "";
}

function hideNow() {
  const section = ensureSection();
  if (section) section.classList.add("hidden");
  nowState.lastCallSignature = "";
}

async function tick() {
  if (nowState.busy) return;
  nowState.busy = true;
  try {
    const credentials = currentCredentials();
    const identityChanged = credentials.token !== nowState.token;
    const clubChanged = credentials.clubId !== nowState.clubId;
    nowState.token = credentials.token;
    nowState.clubId = credentials.clubId;

    if (!nowState.token || !nowState.clubId) {
      nowState.playerId = 0;
      nowState.dashboard = null;
      hideNow();
      return;
    }

    if (identityChanged) {
      nowState.playerId = 0;
      nowState.dashboard = null;
      nowState.lastMetaAt = 0;
      await refreshIdentity();
    }
    if (!nowState.playerId) {
      await refreshIdentity();
    }
    if (!nowState.playerId) {
      hideNow();
      return;
    }

    if (clubChanged) nowState.lastMetaAt = 0;
    if (!nowState.lastMetaAt || Date.now() - nowState.lastMetaAt > META_REFRESH_MS) {
      await refreshMeta();
    }

    const callData = await request(`/clubs/${nowState.clubId}/match-calls`);
    const calls = Array.isArray(callData?.items) ? callData.items : [];
    const match = matchForPlayer(calls);
    if (match) renderCall(match);
    else renderWaiting();
  } catch (error) {
    if (Number(error?.status || 0) === 401) {
      nowState.playerId = 0;
      nowState.dashboard = null;
    }
    console.warn("Akkurat nå kunne ikke oppdateres", error);
  } finally {
    nowState.busy = false;
    schedule();
  }
}

function schedule() {
  if (nowState.timer) window.clearTimeout(nowState.timer);
  nowState.timer = window.setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS);
}

ensureStyles();
ensureSection();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
  else schedule();
});
window.addEventListener("storage", (event) => {
  if ([TOKEN_KEY, CLUB_KEY].includes(event.key || "")) tick();
});
window.addEventListener("bd:player-state-changed", () => {
  nowState.lastMetaAt = 0;
  tick();
});
tick();
