(() => {
  const undoButton = document.getElementById("undoButton");
  if (!undoButton) return;

  const DEFAULT_LABEL = "Angre siste kast";

  function internalUndoButton() {
    return document.querySelector("#scoliaLiveSurface [data-scolia-live-undo]");
  }

  function isScoliaLive() {
    return document.body.classList.contains("scolia-live-active");
  }

  function setLabel(label) {
    const next = label || DEFAULT_LABEL;
    if (undoButton.textContent !== next) undoButton.textContent = next;
  }

  function syncUndoButton() {
    if (!isScoliaLive()) {
      undoButton.classList.remove("scolia-routing-active");
      undoButton.removeAttribute("data-scolia-undo");
      setLabel(DEFAULT_LABEL);
      return;
    }

    const scoliaUndo = internalUndoButton();
    undoButton.classList.add("scolia-routing-active");
    undoButton.setAttribute("data-scolia-undo", "1");

    if (!scoliaUndo) {
      setLabel(DEFAULT_LABEL);
      undoButton.disabled = true;
      return;
    }

    const label = String(scoliaUndo.textContent || DEFAULT_LABEL)
      .replace(/^↶\s*/, "")
      .replace("Scolia-", "");
    setLabel(label);
    undoButton.disabled = Boolean(scoliaUndo.disabled);
  }

  undoButton.addEventListener("click", (event) => {
    if (!isScoliaLive()) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const scoliaUndo = internalUndoButton();
    if (!scoliaUndo || scoliaUndo.disabled) return;
    scoliaUndo.click();
    window.setTimeout(syncUndoButton, 0);
  }, true);

  const observer = new MutationObserver(syncUndoButton);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.setInterval(syncUndoButton, 500);
  syncUndoButton();
})();
