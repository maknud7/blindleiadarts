(() => {
  const COUNTDOWN_SECONDS = 10;
  let lastMatch = captureMatch();
  let countdownHandle = null;
  const shownMatchIds = new Set();

  function captureMatch() {
    let match = null;
    try { match = typeof currentMatch === "function" ? currentMatch() : null; } catch { match = null; }
    if (!match) return null;
    return {
      id: Number(match.id || 0),
      status: String(match.status || ""),
      tournamentName: String(match.tournament_name || ""),
      round: String(match.round_label || match.bracket_label || "Kamp"),
      playerAId: Number(match.player_a?.id || 0),
      playerAName: String(match.player_a?.display_name || "Spiller 1"),
      playerALegs: Number(match.player_a?.legs_won || 0),
      playerBId: Number(match.player_b?.id || 0),
      playerBName: String(match.player_b?.display_name || "Spiller 2"),
      playerBLegs: Number(match.player_b?.legs_won || 0),
    };
  }

  function ensureOverlay() {
    let overlay = document.getElementById("kioskMatchCompletionOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "kioskMatchCompletionOverlay";
    overlay.className = "kiosk-match-completion-overlay hidden";
    overlay.innerHTML = `
      <section class="kiosk-match-completion-card" role="dialog" aria-modal="true" aria-labelledby="kioskMatchCompletionTitle">
        <p class="kiosk-match-completion-kicker">Resultat registrert</p>
        <h2 id="kioskMatchCompletionTitle">KAMP FERDIG</h2>
        <div id="kioskMatchWinner" class="kiosk-match-winner">Henter kampstatistikk …</div>
        <div id="kioskMatchFinalScore" class="kiosk-match-final-score"><strong>–</strong><span>–</span><strong>–</strong></div>
        <div id="kioskMatchCompletionMeta" class="kiosk-match-completion-meta"></div>
        <div id="kioskMatchStats" class="kiosk-match-stats"></div>
        <div class="kiosk-match-next">
          <strong id="kioskMatchNextTitle">Neste kamp klargjøres</strong>
          <span id="kioskMatchCountdown" class="kiosk-match-countdown"></span>
        </div>
        <button id="kioskMatchCompletionSkip" class="kiosk-match-completion-skip" type="button">Vis neste kamp nå</button>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#kioskMatchCompletionSkip")?.addEventListener("click", () => finishTransition());
    return overlay;
  }

  function statValue(value, decimals = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
  }

  function statsCard(name, stats) {
    return `<section class="kiosk-match-stat-player">
      <strong>${escapeHtml(name)}</strong>
      <div class="kiosk-match-stat-grid">
        <div><span>3DA</span><strong>${statValue(stats?.average, 2)}</strong></div>
        <div><span>Checkout</span><strong>${statValue(stats?.highest_checkout)}</strong></div>
        <div><span>180</span><strong>${statValue(stats?.score_180)}</strong></div>
        <div><span>Piler</span><strong>${statValue(stats?.darts_thrown)}</strong></div>
      </div>
    </section>`;
  }

  function setNextCopy(nextMatch) {
    const title = document.getElementById("kioskMatchNextTitle");
    if (!title) return;
    if (nextMatch && nextMatch.id > 0) {
      title.textContent = `Neste: ${nextMatch.playerAName} vs ${nextMatch.playerBName}`;
    } else {
      title.textContent = "Skiva går tilbake til klar-status";
    }
  }

  async function showCompletion(previous, nextMatch) {
    if (!previous?.id || shownMatchIds.has(previous.id)) return;
    shownMatchIds.add(previous.id);
    window.clearInterval(countdownHandle);
    countdownHandle = null;

    document.getElementById("legWinOverlay")?.classList.add("hidden");
    const overlay = ensureOverlay();
    overlay.classList.remove("hidden");
    document.body.classList.add("kiosk-match-transition-active");

    const winner = overlay.querySelector("#kioskMatchWinner");
    const score = overlay.querySelector("#kioskMatchFinalScore");
    const meta = overlay.querySelector("#kioskMatchCompletionMeta");
    const stats = overlay.querySelector("#kioskMatchStats");
    if (winner) winner.textContent = "Henter kampstatistikk …";
    if (score) score.innerHTML = `<strong>${previous.playerALegs}</strong><span>–</span><strong>${previous.playerBLegs}</strong>`;
    if (meta) meta.textContent = previous.round;
    if (stats) stats.innerHTML = "";
    setNextCopy(nextMatch);

    try {
      const detail = await api(`/matches/${previous.id}/detail`);
      const match = detail?.match || {};
      const aStats = detail?.player_a_stats || {};
      const bStats = detail?.player_b_stats || {};
      const aName = match.player_a_name || previous.playerAName;
      const bName = match.player_b_name || previous.playerBName;
      const aLegs = Number(aStats.legs_won ?? previous.playerALegs ?? 0);
      const bLegs = Number(bStats.legs_won ?? previous.playerBLegs ?? 0);
      const winnerName = Number(match.winner_player_id || 0) === Number(match.player_a_id || previous.playerAId)
        ? aName
        : Number(match.winner_player_id || 0) === Number(match.player_b_id || previous.playerBId)
          ? bName
          : "Kampen er registrert";

      if (winner) winner.textContent = match.winner_player_id ? `${winnerName} vinner` : winnerName;
      if (score) score.innerHTML = `<strong>${aLegs}</strong><span>–</span><strong>${bLegs}</strong>`;
      if (meta) meta.textContent = [match.tournament_name || previous.tournamentName, match.round_label || match.bracket_label || previous.round].filter(Boolean).join(" · ");
      if (stats) stats.innerHTML = `${statsCard(aName, aStats)}${statsCard(bName, bStats)}`;
    } catch (error) {
      if (winner) winner.textContent = `${previous.playerAName} vs ${previous.playerBName}`;
      if (stats) stats.innerHTML = `<div class="kiosk-match-completion-meta">Statistikken kunne ikke hentes akkurat nå, men resultatet er registrert.</div>`;
      console.warn("Kunne ikke hente kampstatistikk etter fullført kamp", error);
    }

    startCountdown();
  }

  function startCountdown() {
    let remaining = COUNTDOWN_SECONDS;
    const node = document.getElementById("kioskMatchCountdown");
    const paint = () => {
      if (node) node.textContent = `Neste kamp vises om ${remaining} sek${remaining === 1 ? "und" : "under"}.`;
    };
    paint();
    countdownHandle = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        finishTransition();
        return;
      }
      paint();
    }, 1000);
  }

  async function finishTransition() {
    window.clearInterval(countdownHandle);
    countdownHandle = null;
    try {
      if (typeof loadState === "function") await loadState();
    } catch { /* the already rendered snapshot is still safe to reveal */ }
    document.getElementById("kioskMatchCompletionOverlay")?.classList.add("hidden");
    document.body.classList.remove("kiosk-match-transition-active");
  }

  if (typeof render === "function") {
    const previousRender = render;
    render = function renderWithMatchCompletion() {
      const before = lastMatch;
      const next = captureMatch();
      previousRender();

      const completedTransition = before?.id > 0
        && before.status === "in_progress"
        && (next === null || next.id !== before.id || next.status === "completed");

      if (completedTransition) {
        showCompletion(before, next).catch((error) => console.error("Klarte ikke vise kamp ferdig", error));
      }
      lastMatch = next;
    };
  }

  ensureOverlay();
})();
