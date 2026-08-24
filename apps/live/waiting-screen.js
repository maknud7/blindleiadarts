(() => {
  const isolatedProd = window.location.hostname === "dart.ingenting.org" && window.location.pathname.startsWith("/live");
  const apiBase = isolatedProd ? "./api" : "../api";
  const CURRENT_URL = `${apiBase}/dartsatlas-public-current.php`;
  const SEASON_ELO_URL = `${apiBase}/dartsatlas-public-season-elo.php`;
  const REFRESH_MS = 30000;

  const elements = {
    panel: document.getElementById("waitingPanel"),
    livePanel: document.getElementById("livePanel"),
    liveDot: document.getElementById("liveDot"),
    tournamentName: document.getElementById("tournamentName"),
    tournamentMeta: document.getElementById("tournamentMeta"),
    name: document.getElementById("waitingTournamentName"),
    startLabel: document.getElementById("waitingStartLabel"),
    message: document.getElementById("waitingMessage"),
    countdownState: document.getElementById("countdownState"),
    days: document.getElementById("countdownDays"),
    hours: document.getElementById("countdownHours"),
    minutes: document.getElementById("countdownMinutes"),
    seconds: document.getElementById("countdownSeconds"),
    eloTable: document.getElementById("eloTable"),
    eloLeader: document.getElementById("eloLeader"),
    eloLeaderPlayer: document.getElementById("eloLeaderPlayer"),
    liveMatches: document.getElementById("liveMatches"),
    recentResults: document.getElementById("recentResults"),
  };

  if (!elements.panel || !elements.livePanel || !elements.liveDot) return;

  let current = null;
  let liveElo = null;
  let refreshTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pad(value) {
    return String(Math.max(0, value)).padStart(2, "0");
  }

  function startDate() {
    if (!current?.scheduled_at) return null;
    const date = new Date(current.scheduled_at);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatStart(date) {
    const now = new Date();
    const sameDay = date.toLocaleDateString("nb-NO") === now.toLocaleDateString("nb-NO");
    if (sameDay) {
      return `i kveld kl. ${date.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}`;
    }
    return new Intl.DateTimeFormat("nb-NO", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function hasTournamentActivity() {
    const providerStatus = String(current?.status || "").toLowerCase();
    if (providerStatus === "in_progress") return true;

    return Boolean(
      elements.liveMatches?.querySelector(".match-card") ||
      elements.recentResults?.querySelector(".list-row")
    );
  }

  function setCountdown(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    elements.days.textContent = pad(days);
    elements.hours.textContent = pad(hours);
    elements.minutes.textContent = pad(minutes);
    elements.seconds.textContent = pad(remainingSeconds);
  }

  function setUnknownCountdown() {
    elements.days.textContent = "—";
    elements.hours.textContent = "—";
    elements.minutes.textContent = "—";
    elements.seconds.textContent = "—";
  }

  function renderElo() {
    const table = Array.isArray(liveElo?.table) ? liveElo.table : [];
    if (!elements.eloTable || table.length === 0) return;

    elements.eloTable.innerHTML = table.map((entry) => {
      const rating = Number(entry.rating ?? 1000).toFixed(1).replace(".", ",");
      return `
        <div class="list-row">
          <div>
            <strong><span class="rank">${escapeHtml(entry.position)}</span>${escapeHtml(entry.display_name)}</strong>
            <small>${Number(entry.played || 0)} kamper</small>
          </div>
          <span class="list-value elo-rating">${rating}</span>
        </div>`;
    }).join("");

    const leader = table[0];
    if (leader && elements.eloLeader && elements.eloLeaderPlayer) {
      elements.eloLeader.textContent = Number(leader.rating ?? 1000).toFixed(1).replace(".", ",");
      elements.eloLeaderPlayer.textContent = leader.display_name || "";
    }
  }

  function render() {
    const activity = hasTournamentActivity();
    document.body.classList.toggle("is-waiting", !activity);

    if (activity) {
      // Provider status is enough to enter live mode. We should not hide the
      // dashboard while waiting for the first parsed match card/result.
      elements.panel.hidden = true;
      elements.livePanel.hidden = false;
      return;
    }

    renderElo();
    elements.panel.hidden = false;
    elements.livePanel.hidden = true;

    const date = startDate();
    if (!current?.name) {
      elements.name.textContent = "Neste turnering publiseres snart";
      elements.startLabel.textContent = "Vi følger DartsAtlas-kalenderen automatisk.";
      elements.message.textContent = "Mandagsserie-ELOen under står klar mens vi venter på neste kampkveld.";
      elements.countdownState.textContent = "Venter på starttid";
      setUnknownCountdown();
      return;
    }

    elements.name.textContent = current.name;
    elements.tournamentName.textContent = current.name;

    if (!date) {
      elements.startLabel.textContent = "Starttid er ikke tilgjengelig ennå.";
      elements.tournamentMeta.textContent = "Neste turnering er funnet i DartsAtlas";
      elements.message.textContent = "ELO-tabellen under viser stillingen inn mot neste kampkveld.";
      elements.countdownState.textContent = "Venter på starttid";
      setUnknownCountdown();
      return;
    }

    const formatted = formatStart(date);
    const remainingMs = date.getTime() - Date.now();
    elements.startLabel.textContent = `Planlagt ${formatted}`;
    elements.tournamentMeta.textContent = `Neste turnering · ${formatted}`;

    if (remainingMs > 0) {
      elements.countdownState.textContent = "Starter om";
      elements.message.textContent = current.is_today
        ? "Vi teller ned til avkast. Livekamper og statistikk dukker opp automatisk når turneringen starter."
        : "ELO-tabellen under viser stillingen inn mot neste mandagsrunde.";
      setCountdown(remainingMs / 1000);
      return;
    }

    elements.countdownState.textContent = "Starter snart";
    elements.message.textContent = "Planlagt starttid er passert. Vi venter på at første kamp blir registrert i DartsAtlas.";
    setCountdown(0);
  }

  async function getJson(url) {
    const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(`HTTP ${response.status}`);
    return payload.data || {};
  }

  async function refreshCurrent() {
    const [currentResult, eloResult] = await Promise.allSettled([
      getJson(CURRENT_URL),
      getJson(SEASON_ELO_URL),
    ]);

    if (currentResult.status === "fulfilled") current = currentResult.value;
    if (eloResult.status === "fulfilled") liveElo = eloResult.value?.live_elo || null;

    render();
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshCurrent, REFRESH_MS);
  }

  const observer = new MutationObserver(render);
  observer.observe(elements.liveDot, { attributes: true, attributeFilter: ["class"] });
  if (elements.liveMatches) observer.observe(elements.liveMatches, { childList: true, subtree: true });
  if (elements.recentResults) observer.observe(elements.recentResults, { childList: true, subtree: true });

  window.setInterval(render, 1000);
  window.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCurrent().catch(() => undefined);
  });
  refreshCurrent().catch(() => undefined);
})();
