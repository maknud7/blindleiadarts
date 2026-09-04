const host = document.getElementById("tournaments");

if (host) {
  const MIN_PLAYERS = 2;
  let observer = null;
  let syncing = false;

  function selectedCount() {
    return document.querySelectorAll('#tcBoardSelection input[data-board-id]:checked').length;
  }

  function setHtmlIfChanged(node, html) {
    if (node && node.innerHTML !== html) node.innerHTML = html;
  }

  function setTextIfChanged(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function syncDraftMinimum(leader, state) {
    if (String(state.status || "") !== "draft") return;
    const next = leader.querySelector("#tcLeaderNext");
    if (!next) return;

    const checked = Number(state.checked || 0);
    const active = Number(state.active || checked);
    const pending = Math.max(0, active - checked);

    if (checked < MIN_PLAYERS) {
      setHtmlIfChanged(next, `
        <div class="tc-leader-next-copy">
          <span>Innsjekk</span>
          <strong>${checked} av minst ${MIN_PLAYERS} spillere klare</strong>
          <p>${pending ? `${pending} påmeldte mangler innsjekk.` : "Flere spillere må sjekkes inn før oppmøtet kan låses."}</p>
        </div>
        <button type="button" class="button" data-leader-action="checkin">Sjekk inn spillere</button>`);
      return;
    }

    setHtmlIfChanged(next, `
      <div class="tc-leader-next-copy">
        <span>Oppmøtet ser klart ut</span>
        <strong>${checked} spillere blir med</strong>
        <p>${pending ? `${pending} påmeldte er ikke sjekket inn og blir markert som ikke møtt.` : "Alle med bekreftet plass er sjekket inn."}</p>
      </div>
      <button type="button" class="button" data-leader-action="finish-checkin">Avslutt innsjekk</button>`);
  }

  function syncBoardState(leader, state) {
    if (String(state.status || "") !== "ready") return;

    const count = selectedCount();
    const boardsStep = leader.querySelector('[data-leader-step="boards"]');
    const startStep = leader.querySelector('[data-leader-step="start"]');
    const next = leader.querySelector("#tcLeaderNext");
    if (!boardsStep || !startStep || !next) return;

    const boardsNumber = boardsStep.querySelector(".tc-leader-step-number");
    const startNumber = startStep.querySelector(".tc-leader-step-number");

    if (count > 0) {
      boardsStep.dataset.state = "done";
      boardsStep.removeAttribute("aria-current");
      setTextIfChanged(boardsNumber, "✓");

      startStep.dataset.state = "current";
      startStep.setAttribute("aria-current", "step");
      setTextIfChanged(startNumber, "5");

      setHtmlIfChanged(next, `
        <div class="tc-leader-next-copy">
          <span>Klar til start</span>
          <strong>${Number(state.checked || 0)} spillere · ${count} ${count === 1 ? "skive" : "skiver"}</strong>
          <p>Disse skivene lagres før start. Nye kamper sendes bare til skivene som er valgt for turneringen.</p>
        </div>
        <button type="button" class="button" data-leader-action="start">Start turnering</button>`);
    } else {
      boardsStep.dataset.state = "current";
      boardsStep.setAttribute("aria-current", "step");
      setTextIfChanged(boardsNumber, "4");

      startStep.dataset.state = "available";
      startStep.removeAttribute("aria-current");
      setTextIfChanged(startNumber, "5");

      setHtmlIfChanged(next, `
        <div class="tc-leader-next-copy">
          <span>Skiver</span>
          <strong>Velg skivene turneringen skal bruke</strong>
          <p>Ingen skiver er bekreftet. Minst én aktiv skive må velges før start.</p>
        </div>
        <button type="button" class="button" data-leader-action="boards">Velg skiver</button>`);
    }

    state.selectedBoardCount = count;
  }

  function syncLeaderState() {
    if (syncing) return;
    const leader = document.getElementById("tcLeaderV2");
    const state = window.__bdTournamentLeaderState;
    if (!leader || !state) return;
    syncing = true;
    try {
      syncDraftMinimum(leader, state);
      syncBoardState(leader, state);
    } finally {
      window.setTimeout(() => { syncing = false; }, 0);
    }
  }

  function ensureObserver() {
    const leader = document.getElementById("tcLeaderV2");
    if (!leader || observer) return;
    observer = new MutationObserver(() => window.requestAnimationFrame(syncLeaderState));
    observer.observe(leader, { childList: true, subtree: true });
  }

  host.addEventListener("change", (event) => {
    if (event.target.closest('#tcBoardSelection input[data-board-id]')) {
      window.requestAnimationFrame(syncLeaderState);
    }
  });

  window.addEventListener("bd:tournament-board-selection-change", () => window.requestAnimationFrame(syncLeaderState));
  window.addEventListener("bd:tournament-boards-updated", () => window.requestAnimationFrame(syncLeaderState));
  window.addEventListener("bd:tournament-tools-ready", () => {
    ensureObserver();
    window.requestAnimationFrame(syncLeaderState);
  });
  window.addEventListener("bd:tournament-context", () => window.setTimeout(() => {
    ensureObserver();
    syncLeaderState();
  }, 0));

  ensureObserver();
  syncLeaderState();
}
