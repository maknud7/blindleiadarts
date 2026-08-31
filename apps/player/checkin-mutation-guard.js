(() => {
  if (window.__bdCheckinMutationGuardInstalled || typeof window.MutationObserver !== "function") return;
  window.__bdCheckinMutationGuardInstalled = true;

  const NativeMutationObserver = window.MutationObserver;
  let initialReady = false;
  let settleTimer = 0;
  let safetyTimer = 0;

  const bootStyle = document.createElement("style");
  bootStyle.id = "playerNowInitialRenderGuard";
  bootStyle.textContent = `
    body:not(.bd-player-now-ready) #playerNowCard {
      visibility:hidden!important;
    }
  `;
  document.head.appendChild(bootStyle);

  function playerNowStable() {
    const card = document.getElementById("playerNowCard");
    if (!card) return false;
    const status = String(document.getElementById("playerNowStatus")?.textContent || "").trim();
    const body = document.getElementById("playerNowBody");
    if (!body || !status || status === "Laster") return false;
    if (body.textContent?.includes("Henter det som er viktigst")) return false;

    const checkin = card.querySelector("button[data-px-checkin]");
    if (checkin && !checkin.dataset.checkinWindowOriginalText) return false;
    return true;
  }

  function revealPlayerNow() {
    if (initialReady) return;
    initialReady = true;
    window.clearTimeout(settleTimer);
    window.clearTimeout(safetyTimer);
    document.body.classList.add("bd-player-now-ready");
  }

  function schedulePlayerNowReveal() {
    if (initialReady) return;
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (playerNowStable()) revealPlayerNow();
    }, 240);
  }

  const initialObserver = new NativeMutationObserver((records) => {
    if (initialReady) return;
    const relevant = records.some((record) => {
      const target = record.target instanceof Element ? record.target : record.target?.parentElement;
      if (target?.closest?.("#playerNowCard")) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => {
        const element = node instanceof Element ? node : node?.parentElement;
        return !!element?.closest?.("#playerNowCard");
      });
    });
    if (relevant || document.getElementById("playerNowCard")) schedulePlayerNowReveal();
  });
  initialObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  safetyTimer = window.setTimeout(revealPlayerNow, 3500);
  schedulePlayerNowReveal();

  function elementFor(node) {
    if (node instanceof Element) return node;
    return node?.parentElement || null;
  }

  function isCheckinTextOnlyMutation(record) {
    if (record.type !== "childList") return false;
    const target = elementFor(record.target);
    if (!target) return false;
    const checkinTarget = target.closest(
      "button[data-checkin],button[data-px-checkin],button.checkin-window-disabled,#playerNowHint"
    );
    if (!checkinTarget) return false;

    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    return changedNodes.length > 0 && changedNodes.every((node) => node.nodeType === Node.TEXT_NODE);
  }

  function filtered(records) {
    return records.filter((record) => !isCheckinTextOnlyMutation(record));
  }

  class GuardedMutationObserver {
    constructor(callback) {
      this._inner = new NativeMutationObserver((records) => {
        const useful = filtered(records);
        if (useful.length) callback(useful, this);
      });
    }

    observe(target, options) {
      return this._inner.observe(target, options);
    }

    disconnect() {
      return this._inner.disconnect();
    }

    takeRecords() {
      return filtered(this._inner.takeRecords());
    }
  }

  window.MutationObserver = GuardedMutationObserver;
})();