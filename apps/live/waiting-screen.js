(() => {
  const CURRENT_URL = "../api/dartsatlas-public-current.php";
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
  };

  if (!elements.panel || !elements.livePanel || !elements.liveDot) return;

  let current = null;
  let refreshTimer = null;

  function pad(value) {
    return String(Math.max(0, value)).padStart(2, "0");
  }

  function startDate() {
    if (!current?.scheduled_at) return null;
    const date = new Date(current.scheduled_at);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatStart(date) {
    return new Intl.DateTimeFormat("nb-NO", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
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

  function render() {
    const isLive = elements.liveDot.classList.contains("is-live");
    if (isLive) {
      elements.panel.hidden = true;
      elements.livePanel.hidden = false;
      return;
    }

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
      elements.message.textContent = "ELO-tabellen under viser stillingen inn mot turneringsstart.";
      setCountdown(remainingMs / 1000);
      return;
    }

    elements.countdownState.textContent = "Starter snart";
    elements.message.textContent = "Planlagt starttid er passert. Vi venter på at første kamp blir markert live i DartsAtlas.";
    setCountdown(0);
  }

  async function refreshCurrent() {
    try {
      const response = await fetch(`${CURRENT_URL}?_=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload?.ok) {
        current = payload.data || null;
      }
    } catch (_) {
      // Keep the last known upcoming tournament on screen if one request fails.
    } finally {
      render();
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refreshCurrent, REFRESH_MS);
    }
  }

  const observer = new MutationObserver(render);
  observer.observe(elements.liveDot, { attributes: true, attributeFilter: ["class"] });

  window.setInterval(render, 1000);
  refreshCurrent().catch(() => undefined);
})();
