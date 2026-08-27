const host = document.getElementById("tournaments");

if (host) {
  function selectedCount() {
    return document.querySelectorAll('#tcBoardSelection input[data-board-id]:checked').length;
  }

  function syncBoardState() {
    const leader = document.getElementById("tcLeaderV2");
    const state = window.__bdTournamentLeaderState;
    if (!leader || !state || String(state.status || "") !== "ready") return;

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
      if (boardsNumber) boardsNumber.textContent = "✓";

      startStep.dataset.state = "current";
      startStep.setAttribute("aria-current", "step");
      if (startNumber) startNumber.textContent = "5";

      next.innerHTML = `
        <div class="tc-leader-next-copy">
          <span>Klar til start</span>
          <strong>${Number(state.checked || 0)} spillere · ${count} ${count === 1 ? "skive" : "skiver"}</strong>
          <p>Skivevalget lagres når turneringen startes. Trekning og gruppekamper opprettes deretter automatisk.</p>
        </div>
        <button type="button" class="button" data-leader-action="start">Start turnering</button>`;
    } else {
      boardsStep.dataset.state = "current";
      boardsStep.setAttribute("aria-current", "step");
      if (boardsNumber) boardsNumber.textContent = "4";

      startStep.dataset.state = "available";
      startStep.removeAttribute("aria-current");
      if (startNumber) startNumber.textContent = "5";

      next.innerHTML = `
        <div class="tc-leader-next-copy">
          <span>Skiver</span>
          <strong>Velg skivene turneringen skal bruke</strong>
          <p>Minst én aktiv skive må velges før start.</p>
        </div>
        <button type="button" class="button" data-leader-action="boards">Velg skiver</button>`;
    }

    state.selectedBoardCount = count;
  }

  host.addEventListener("change", (event) => {
    if (event.target.closest('#tcBoardSelection input[data-board-id]')) {
      window.requestAnimationFrame(syncBoardState);
    }
  });

  window.addEventListener("bd:tournament-tools-ready", () => {
    window.requestAnimationFrame(syncBoardState);
  });
}
