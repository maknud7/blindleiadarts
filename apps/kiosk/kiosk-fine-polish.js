(() => {
  const POLISH_VERSION = "1.2";

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

  function keepUndoUsable(undo) {
    if (!undo) return;

    // app.js renders the match while state.mutating is still true after a visit,
    // which leaves this button disabled even after the request has completed.
    // Keep the control available and guard the actual click while a mutation is
    // genuinely in flight, so we neither lose undo nor allow concurrent writes.
    undo.disabled = false;

    if (undo.dataset.kioskUndoGuardBound === "1") return;
    undo.dataset.kioskUndoGuardBound = "1";
    undo.addEventListener("click", (event) => {
      if (typeof state !== "undefined" && state.mutating) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
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
    keepUndoUsable(undo);
  }

  function strengthenTurnMarker() {
    [document.getElementById("playerATurn"), document.getElementById("playerBTurn")].forEach((node) => {
      if (node && node.textContent !== "Kaster nå") node.textContent = "Kaster nå";
    });
  }

  function preserveScoringFeedback() {
    const hint = document.getElementById("sumHint");
    if (hint) {
      const text = String(hint.textContent || "").trim();
      const redundant = /^Gjenstår\s+\d+$/i.test(text) || text === "Trykk Lagre kast for 0";
      hint.classList.toggle("is-redundant", redundant);
    }

    const previewMeta = document.querySelector("#kioskLiveRemaining small");
    if (previewMeta) {
      const text = String(previewMeta.textContent || "").trim();
      previewMeta.classList.toggle("is-important", /^(?:BUST|CHECKOUT)$/i.test(text));
    }
  }

  function ensureFallbackStyles() {
    if (document.getElementById("kioskFallbackGridStyles")) return;
    const style = document.createElement("style");
    style.id = "kioskFallbackGridStyles";
    style.textContent = `
      #manualScoring.scolia-fallback-layout {
        grid-template-rows: 48px auto minmax(0, 1fr) !important;
        gap: 4px !important;
        align-content: stretch !important;
        min-height: 0 !important;
        overflow: hidden !important;
      }
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice:not(.hidden) {
        min-width: 0 !important;
        min-height: 48px !important;
        height: 48px !important;
        max-height: 48px !important;
        margin: 0 !important;
        padding: 5px 8px !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        gap: 7px !important;
        align-items: center !important;
        overflow: hidden !important;
        border-radius: 11px !important;
      }
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice .eyebrow,
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice .muted {
        display: none !important;
      }
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice > div {
        min-width: 0 !important;
        display: block !important;
        overflow: hidden !important;
      }
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice strong {
        display: block !important;
        overflow: hidden !important;
        font-size: 13px !important;
        line-height: 1.1 !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      #manualScoring.scolia-fallback-layout #scoliaFallbackNotice .confirm-button {
        min-width: 0 !important;
        max-width: 230px !important;
        min-height: 36px !important;
        height: 36px !important;
        max-height: 36px !important;
        padding: 5px 10px !important;
        font-size: 11px !important;
        line-height: 1.05 !important;
        white-space: nowrap !important;
      }
      #manualScoring.scolia-fallback-layout .scoring-head {
        min-height: 40px !important;
        margin: 0 !important;
      }
      #manualScoring.scolia-fallback-layout #sumMode,
      #manualScoring.scolia-fallback-layout #dartMode {
        height: auto !important;
        min-height: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
      }
      #manualScoring.scolia-fallback-layout #sumMode {
        grid-template-rows: 46px minmax(0, 1fr) !important;
        gap: 5px !important;
      }
      #manualScoring.scolia-fallback-layout #sumMode .entry-display {
        height: 46px !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding-block: 4px !important;
      }
      #manualScoring.scolia-fallback-layout #sumMode .keypad {
        min-height: 0 !important;
        height: 100% !important;
        grid-template-rows: repeat(4, minmax(30px, 1fr)) !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode {
        grid-template-rows: 36px minmax(0, 1fr) 42px !important;
        gap: 5px !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .dart-summary {
        min-height: 0 !important;
        height: 36px !important;
        margin: 0 !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .dart-controls {
        min-height: 0 !important;
        height: 100% !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .number-grid {
        min-height: 0 !important;
        height: 100% !important;
        grid-template-rows: repeat(4, minmax(26px, 1fr)) !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .dart-controls > div:last-child {
        min-height: 0 !important;
        grid-template-rows: 34px minmax(0, 1fr) !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .special-grid {
        min-height: 0 !important;
        height: 34px !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .dart-actions {
        min-height: 0 !important;
        height: 42px !important;
        margin: 0 !important;
      }
      #manualScoring.scolia-fallback-layout #dartMode .dart-actions button {
        min-height: 0 !important;
        height: 42px !important;
      }
      @media (max-width: 620px) {
        #manualScoring.scolia-fallback-layout #scoliaFallbackNotice .confirm-button {
          max-width: 175px !important;
          font-size: 10px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureFallbackLayout() {
    ensureFallbackStyles();
    const manual = document.getElementById("manualScoring");
    const notice = document.getElementById("scoliaFallbackNotice");
    if (!manual || !notice) return;

    const active = !notice.classList.contains("hidden");
    manual.classList.toggle("scolia-fallback-layout", active);
    if (active) {
      // scolia-live-ux.js deliberately uses inline !important to reveal manual
      // scoring. Keep that override, but make the revealed card a height-aware
      // grid so neither input mode can be clipped by the kiosk viewport.
      manual.style.setProperty("display", "grid", "important");
    }
  }

  function applyFinePolish() {
    document.body.classList.add("kiosk-fine-polish");
    document.body.dataset.kioskFinePolish = POLISH_VERSION;
    compactLiveStatus();
    ensureMatchContext();
    moveUndoToScoring();
    strengthenTurnMarker();
    preserveScoringFeedback();
    ensureFallbackLayout();
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
    ensureFallbackLayout();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  applyFinePolish();
})();