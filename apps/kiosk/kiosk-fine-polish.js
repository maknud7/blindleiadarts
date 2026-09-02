(() => {
  const POLISH_VERSION = "1.0";

  function compactLiveStatus() {
    const node = document.getElementById("connectionText");
    if (!node) return;
    const text = String(node.textContent || "").trim();
    if (/^(?:Board|Skive)\s+\d+\s*·\s*live$/i.test(text)) {
      node.textContent = "Live";
    }
  }

  function ensureMatchContext() {
    const center = document.querySelector(".match-center");
    if (!center) return;

    let context = document.getElementById("matchContextLine");
    if (!context) {
      context = document.createElement("span");
      context.id = "matchContextLine";
      context.className = "match-context-line";
      const legsScore = document.getElementById("matchLegsScore");
      if (legsScore?.nextSibling) center.insertBefore(context, legsScore.nextSibling);
      else center.appendChild(context);
    }

    const leg = String(document.getElementById("currentLeg")?.textContent || "").trim();
    const round = String(document.getElementById("matchRound")?.textContent || "").trim();
    const next = [leg, round].filter(Boolean).join(" · ");
    if (context.textContent !== next) context.textContent = next;
  }

  function moveUndoToScoring() {
    const undo = document.getElementById("undoButton");
    const head = document.querySelector("#manualScoring .scoring-head");
    const mode = head?.querySelector(".mode-switch");
    if (!undo || !head || !mode) return;

    if (undo.parentElement !== head) head.insertBefore(undo, mode);
    undo.classList.add("kiosk-undo-inline");
    if (undo.textContent !== "↶ Angre") undo.textContent = "↶ Angre";
    undo.setAttribute("aria-label", "Angre siste kast");
    undo.title = "Angre siste kast";
  }

  function strengthenTurnMarker() {
    [document.getElementById("playerATurn"), document.getElementById("playerBTurn")].forEach((node) => {
      if (node && node.textContent !== "Kaster nå") node.textContent = "Kaster nå";
    });
  }

  function applyFinePolish() {
    document.body.classList.add("kiosk-fine-polish");
    document.body.dataset.kioskFinePolish = POLISH_VERSION;
    compactLiveStatus();
    ensureMatchContext();
    moveUndoToScoring();
    strengthenTurnMarker();
  }

  if (typeof setConnection === "function") {
    const previousSetConnection = setConnection;
    setConnection = function setConnectionFinePolish(text, tone) {
      const raw = String(text || "").trim();
      const next = /^(?:Board|Skive)\s+\d+\s*·\s*live$/i.test(raw) ? "Live" : text;
      const result = previousSetConnection(next, tone);
      compactLiveStatus();
      return result;
    };
  }

  if (typeof render === "function") {
    const previousRender = render;
    render = function renderFinePolish() {
      const result = previousRender();
      applyFinePolish();
      return result;
    };
  }

  if (typeof renderInput === "function") {
    const previousRenderInput = renderInput;
    renderInput = function renderInputFinePolish() {
      const result = previousRenderInput();
      applyFinePolish();
      return result;
    };
  }

  const observer = new MutationObserver(() => {
    compactLiveStatus();
    ensureMatchContext();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  applyFinePolish();
})();
