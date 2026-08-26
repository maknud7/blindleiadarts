(() => {
  const idle = document.getElementById("idleState");
  if (!idle) return;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "./operations-runtime.css?v=20260826-1145";
  document.head.appendChild(css);

  const panel = document.createElement("div");
  panel.className = "post-match-panel";
  panel.innerHTML = `
    <div id="opsResult" class="post-match-result hidden">
      <p class="eyebrow">Kampen er registrert</p>
      <h3 id="opsWinner">—</h3>
      <p id="opsScore" class="muted">—</p>
      <div id="opsUpcoming" class="post-match-upcoming hidden">
        <span>Neste kamp</span>
        <strong id="opsUpcomingPlayers">—</strong>
        <small id="opsUpcomingRound">—</small>
      </div>
      <div class="post-match-countdown"><span>Neste kamp vises om</span><strong id="opsCountdown">30</strong><span>sek</span></div>
      <p class="post-match-hint">Resultatet kan korrigeres mens nedtellingen pågår.</p>
    </div>
    <div class="post-match-actions">
      <button id="opsUndo" type="button" class="ghost-button hidden">Angre siste</button>
    </div>
    <p id="opsStatus" class="muted post-match-status"></p>`;
  idle.appendChild(panel);

  const result = document.getElementById("opsResult");
  const winner = document.getElementById("opsWinner");
  const score = document.getElementById("opsScore");
  const upcoming = document.getElementById("opsUpcoming");
  const upcomingPlayers = document.getElementById("opsUpcomingPlayers");
  const upcomingRound = document.getElementById("opsUpcomingRound");
  const countdown = document.getElementById("opsCountdown");
  const undo = document.getElementById("opsUndo");
  const status = document.getElementById("opsStatus");
  let mutating = false;
  let lastMatchId = 0;
  let lastAutoAttempt = 0;

  function kioskCode() { return localStorage.getItem("bd:kioskCode") || ""; }
  function pairingToken() { return localStorage.getItem("bd:kioskPairingToken") || ""; }
  function headers() {
    const token = pairingToken();
    return token ? { "X-Kiosk-Pairing-Token": token } : {};
  }
  async function request(path, options = {}) {
    const response = await fetch(`../api/v1${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
    return payload.data;
  }
  function isIdleVisible() { return !idle.classList.contains("hidden"); }

  function renderReservation(reservation) {
    if (!reservation) {
      upcoming.classList.add("hidden");
      return;
    }
    upcoming.classList.remove("hidden");
    upcomingPlayers.textContent = `${reservation.player_a_name} – ${reservation.player_b_name}`;
    upcomingRound.textContent = reservation.round_label || reservation.bracket_label || "Kamp";
  }

  async function promoteNext({ quiet = false } = {}) {
    if (mutating) return;
    const now = Date.now();
    if (quiet && now - lastAutoAttempt < 1800) return;
    lastAutoAttempt = now;
    const code = kioskCode();
    if (!code) return;
    mutating = true;
    undo.disabled = true;
    if (!quiet) status.textContent = "Gjør neste kamp klar …";
    try {
      const data = await request(`/kiosks/${encodeURIComponent(code)}/next-match`, { method: "POST" });
      if (data.assignment?.assigned) {
        status.textContent = "Neste kamp er klar.";
        window.location.reload();
        return;
      }
      const reason = data.assignment?.reason;
      if (reason === "reservation_wait") {
        status.textContent = "Neste kamp er reservert og vises når nedtellingen er ferdig.";
      } else if (reason === "no_ready_match") {
        status.textContent = "Ingen kvalifisert kamp akkurat nå. Boardet følger køen automatisk.";
      } else if (reason === "no_active_tournament" || reason === "no_auto_tournament") {
        status.textContent = "Venter på en aktiv turnering med automatisk kampfordeling.";
      } else if (reason === "board_busy") {
        window.location.reload();
        return;
      } else {
        status.textContent = "Boardet følger kampkøen automatisk.";
      }
    } catch (error) {
      if (!quiet) status.textContent = error.message;
    } finally {
      mutating = false;
      undo.disabled = false;
    }
  }

  async function refreshPostMatch() {
    const code = kioskCode();
    if (!code || !isIdleVisible() || mutating) return;
    try {
      const data = await request(`/kiosks/${encodeURIComponent(code)}/post-match`);
      const match = data.last_completed_match || null;
      const reservation = data.reservation || null;
      const remaining = Math.max(0, Number(data.remaining_seconds || 0));
      lastMatchId = Number(match?.id || 0);

      if (!match) {
        result.classList.add("hidden");
        undo.classList.add("hidden");
        upcoming.classList.add("hidden");
        status.textContent = reservation
          ? "Neste kamp er reservert."
          : "Boardet er ledig og følger kampkøen automatisk.";
        if (reservation && remaining <= 0) promoteNext({ quiet: true }).catch(() => undefined);
        if (!reservation) promoteNext({ quiet: true }).catch(() => undefined);
        return;
      }

      result.classList.remove("hidden");
      undo.classList.toggle("hidden", remaining <= 0);
      winner.textContent = `${match.winner_name || "Resultat"} vant`;
      score.textContent = `${match.player_a_name} ${Number(match.legs_a || 0)}–${Number(match.legs_b || 0)} ${match.player_b_name} · ${match.round_label || match.bracket_label || match.tournament_name}`;
      countdown.textContent = String(remaining);
      renderReservation(reservation);

      if (reservation) {
        status.textContent = remaining > 0
          ? "Neste kamp er valgt og venter på resultatvinduet."
          : "Bytter til neste kamp …";
      } else if (remaining > 0) {
        status.textContent = "Resultatet vises i 30 sekunder. Kampmotoren leter etter neste kamp.";
      } else {
        status.textContent = "Resultatvinduet er ferdig. Henter neste kvalifiserte kamp …";
      }

      if (remaining <= 0) promoteNext({ quiet: true }).catch(() => undefined);
    } catch {
      // Den ordinære kiosk-runtimen håndterer tilkoblingsstatus.
    }
  }

  async function undoLast() {
    if (mutating || !lastMatchId) return;
    const code = kioskCode();
    if (!code) return;
    mutating = true;
    undo.disabled = true;
    status.textContent = "Åpner siste kast igjen …";
    try {
      await request(`/kiosks/${encodeURIComponent(code)}/release-next-match`, { method: "POST" });
      await request(`/kiosks/${encodeURIComponent(code)}/undo`, { method: "POST" });
      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
      mutating = false;
      undo.disabled = false;
    }
  }

  undo.addEventListener("click", undoLast);
  window.setInterval(() => refreshPostMatch().catch(() => undefined), 900);
  refreshPostMatch().catch(() => undefined);
})();

import("./scolia-runtime.js").catch((error) => console.warn("Scolia runtime kunne ikke lastes:", error));
